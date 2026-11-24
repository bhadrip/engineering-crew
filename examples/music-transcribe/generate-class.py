#!/usr/bin/env python3
"""Render two original synthetic teacher/student lessons and sample-accurate, private answer keys."""

import argparse
from array import array
import hashlib
import json
import math
from pathlib import Path
import random
import subprocess
import sys
from tempfile import TemporaryDirectory
import wave


RATE = 16_000
TAU = math.tau
SWARAS = ('sa', 'ri', 'ga', 'ma', 'pa', 'dha', 'ni', 'sa')
SEMITONES = (0, 2, 4, 5, 7, 9, 11, 12)

LESSONS = {
    'lesson': {
        'tonic': 220.0, 'beat': 0.49, 'pause': 0.38, 'seed': 41,
        'intro': [('teacher', 'Welcome back. Listen to these four lines, then sing the last line after me.'),
                  ('student', 'I am ready. I will listen first.')],
        'melody': [[(0, 1), (1, 1), (2, 1), (4, 2)], [(4, 1), (3, 1), (2, 1), (1, 2)],
                   [(2, 1), (4, 1), (5, 1), (4, 2)], [(4, 1), (2, 1), (1, 1), (0, 2)]],
        'correction': 'Hold the final note for two counts.',
        'after': [('student', 'I will count both beats before I breathe.'), ('teacher', 'Good. We will begin there next time.')],
    },
    'held-out': {
        'tonic': 196.0, 'beat': 0.66, 'pause': 0.57, 'seed': 83,
        'intro': [('student', 'May we work on the new exercise today?'),
                  ('teacher', 'Yes. Listen to the whole phrase. Then you can join me at the end.'),
                  ('student', 'All right. I will wait for my turn.')],
        'melody': [[(2, 1), (3, 1), (4, 1.5), (5, 1.5)], [(7, 1.5), (5, 0.5), (4, 1), (3, 1.5)],
                   [(1, 0.5), (2, 1), (4, 1.5), (2, 1.5)], [(3, 1), (2, 1), (1, 0.75), (0, 2)]],
        'correction': 'Take a breath before the last phrase.',
        'after': [('student', 'I can leave a little space there.'), ('teacher', 'Exactly. Keep that space when you practice.')],
    },
}


def silence(seconds):
    return array('h', [0]) * round(seconds * RATE)


def speak(voice, words, directory):
    output = Path(directory) / 'voice.wav'
    subprocess.run(['say', '-v', voice, '-r', '155', '--file-format=WAVE', '--data-format=LEI16@16000',
                    '-o', str(output), words], check=True, capture_output=True)
    with wave.open(str(output), 'rb') as wav:
        if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, RATE):
            raise ValueError('Speech synthesis produced an unexpected PCM format')
        pcm = array('h', wav.readframes(wav.getnframes()))
    if sys.byteorder != 'little':
        pcm.byteswap()
    # Trim engine-added silence so the timing key describes speech that can actually be heard.
    nonquiet = [i for i, amplitude in enumerate(pcm) if abs(amplitude) > 120]
    if not nonquiet or len(nonquiet) < RATE // 20:
        raise ValueError(f'Voice {voice} produced no audible speech')
    return pcm[max(0, nonquiet[0] - 160):nonquiet[-1] + 161]


def sing_line(notes, tonic, beat, student, rng):
    pcm = array('h')
    phase = 0.0
    previous_hz = None
    for degree, beats in notes:
        syllable = SWARAS[degree]
        hz = tonic * 2 ** (SEMITONES[degree] / 12) * (0.5 if student else 1.0)
        length = round(beats * beat * RATE)
        vowel_i = syllable in ('ri', 'ni')
        formants = (340, 2050, 2830) if vowel_i else (730, 1210, 2680)
        if student:
            formants = tuple(f * 0.86 for f in formants)
        # The harmonic source follows the pitch; resonances remain at the vowel's formant frequencies.
        harmonics = []
        for k in range(1, min(35, int(6400 / hz)) + 1):
            h = k * hz
            resonance = sum(gain * math.exp(-0.5 * ((h - center) / width) ** 2)
                            for center, width, gain in zip(formants, (110, 165, 220), (1.7, 1.15, 0.65)))
            harmonics.append((k, (0.08 + resonance) / k ** 0.95))
        gain = 11300 / sum(abs(a) for _, a in harmonics)
        noise_prior = 0.0
        for i in range(length):
            t = i / RATE
            glide = math.exp(-t / 0.038)
            pitch = hz + 0.25 * ((previous_hz or hz) - hz) * glide
            pitch *= 1 + 0.006 * min(t * 6, 1) * math.sin(TAU * 5.2 * t)
            phase = (phase + TAU * pitch / RATE) % TAU
            voice = sum(a * math.sin(k * phase) for k, a in harmonics) * gain
            shape = min(1, i / 330, (length - i) / 610)
            if syllable == 'sa' and t < 0.075:
                noise = rng.uniform(-1, 1)
                voice += (noise - noise_prior) * 1250 * (1 - t / 0.075)
                noise_prior = noise
            if syllable in ('ma', 'ni') and t < 0.08:
                voice = voice * 0.65 + 600 * math.sin(phase)
            pcm.append(round(shape * voice))
        previous_hz = hz
    return pcm


def add_drone(pcm, tonic):
    # A pulsed fifth, tonic and low tonic continue through the spaces between lines.
    for i, sample in enumerate(pcm):
        t = i / RATE
        amplitude = 0.0
        for offset, ratio in [(0, 0.75), (0.60, 1.0), (1.20, 1.0), (1.80, 0.5)]:
            age = (t - offset) % 2.40
            env = min(1, age / 0.025) * math.exp(-age * 1.55)
            phase = TAU * tonic * ratio * t
            amplitude += env * (math.sin(phase) + 0.32 * math.sin(2 * phase) + 0.14 * math.sin(3 * phase))
        edge = min(1, i / 1100, (len(pcm) - i) / 1350)
        pcm[i] = round(sample + 610 * edge * amplitude)


def render(name, out_dir, voices, speech=speak):
    cfg = LESSONS[name]
    all_pcm = silence(0.25 if name == 'lesson' else 0.6)
    rng = random.Random(cfg['seed'])
    utterances = []
    lines = []
    out_dir.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory() as directory:
        def utter(role, words):
            start = len(all_pcm) / RATE
            all_pcm.extend(speech(voices[role], words, directory))
            entry = {'role': role, 'voice': voices[role], 'text': words, 'start': start, 'end': len(all_pcm) / RATE}
            utterances.append(entry)
            all_pcm.extend(silence(cfg['pause']))
            return entry

        for role, words in cfg['intro']:
            utter(role, words)
        song_start = len(all_pcm) / RATE
        singing = array('h')
        for n, notes in enumerate(cfg['melody']):
            if n:
                singing.extend(silence(0.29))
            start = song_start + len(singing) / RATE
            singing.extend(sing_line(notes, cfg['tonic'], cfg['beat'], False, rng))
            lines.append({'number': n + 1, 'role': 'teacher', 'repeated': False,
                          'start': start, 'end': song_start + len(singing) / RATE,
                          'swaras': [SWARAS[degree] for degree, _ in notes]})
        add_drone(singing, cfg['tonic'])
        all_pcm.extend(singing)
        song_end = len(all_pcm) / RATE
        all_pcm.extend(silence(0.65 if name == 'lesson' else 1.05))

        def student_take(corrected):
            notes = list(cfg['melody'][-1])
            if name == 'lesson' and not corrected:
                # The error is audible: the student releases the tonic after half a beat.
                notes[-1] = (notes[-1][0], 0.5)
            if name == 'held-out' and corrected:
                breath = array('h', (round(550 * rng.uniform(-1, 1) * math.sin(math.pi * i / 5100))
                                      for i in range(5100)))
                all_pcm.extend(breath)
                all_pcm.extend(silence(0.25))
            start = len(all_pcm) / RATE
            take = sing_line(notes, cfg['tonic'], cfg['beat'] * 1.04, True, rng)
            add_drone(take, cfg['tonic'])
            all_pcm.extend(take)
            lines.append({'number': 4, 'role': 'student', 'repeated': True, 'corrected': corrected,
                          'start': start, 'end': len(all_pcm) / RATE, 'swaras': [SWARAS[d] for d, _ in notes]})
            all_pcm.extend(silence(cfg['pause']))

        utter('teacher', 'Now sing the last line for me.' if name == 'lesson' else 'Your turn. Try the ending.')
        student_take(False)
        correction = utter('teacher', cfg['correction'])
        utter(*cfg['after'][0])
        student_take(True)
        utter(*cfg['after'][1])
    audio_path = out_dir / f'{name}.wav'
    answer_path = out_dir / f'{name}.expected.json'
    if sys.byteorder != 'little':
        all_pcm.byteswap()
    with wave.open(str(audio_path), 'wb') as wav:
        wav.setparams((1, 2, RATE, 0, 'NONE', 'not compressed'))
        wav.writeframes(all_pcm.tobytes())
    answer = {'fixture': name, 'source': 'Original synthetic lesson', 'duration': len(all_pcm) / RATE,
              'sampleRate': RATE, 'audioSha256': hashlib.sha256(audio_path.read_bytes()).hexdigest(),
              'song': {'start': song_start, 'end': song_end}, 'correction': correction, 'utterances': utterances,
              'lines': lines, 'phrases': [line for line in lines if line['number'] == 4], 'tonicHz': cfg['tonic']}
    answer_path.write_text(json.dumps(answer, indent=2) + '\n', encoding='utf-8')
    return answer


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=Path(__file__).resolve().parents[2] / '.crew-local' / 'assets')
    parser.add_argument('--teacher', default='Samantha')
    parser.add_argument('--student', default='Daniel')
    args = parser.parse_args()
    if args.teacher == args.student:
        parser.error('Choose a distinct voice for each speaker')
    for lesson in LESSONS:
        data = render(lesson, args.out, {'teacher': args.teacher, 'student': args.student})
        print(f"Generated {lesson}.wav and its private answer key (SHA-256 {data['audioSha256']})")
