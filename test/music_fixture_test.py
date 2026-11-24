"""Run with python3 -B test/music_fixture_test.py after generating the original lessons."""

from array import array
import hashlib
import json
import math
from pathlib import Path
import sys
import unittest
import wave


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / '.crew-local' / 'assets'


class MusicFixtures(unittest.TestCase):
    def test_original_class_recordings(self):
        variants = []
        for name in ('lesson', 'held-out'):
            with self.subTest(fixture=name):
                answer = json.loads((ASSETS / f'{name}.expected.json').read_text())
                path = ASSETS / f'{name}.wav'
                self.assertEqual(answer['audioSha256'], hashlib.sha256(path.read_bytes()).hexdigest())
                with wave.open(str(path), 'rb') as wav:
                    rate = wav.getframerate()
                    self.assertEqual((wav.getnchannels(), wav.getsampwidth(), rate), (1, 2, 16_000))
                    self.assertEqual(wav.getnframes() / rate, answer['duration'])
                    pcm = array('h', wav.readframes(wav.getnframes()))
                    if sys.byteorder != 'little':
                        pcm.byteswap()
                self.assertLess(max(map(abs, pcm)), 32768)
                def rms(start, end):
                    samples = pcm[round(start * rate):round(end * rate)]
                    return math.sqrt(sum(v * v for v in samples) / len(samples))

                lines, utterances = answer['lines'], answer['utterances']
                self.assertEqual([line['number'] for line in lines], [1, 2, 3, 4, 4, 4])
                self.assertEqual([line['repeated'] for line in lines], [False] * 4 + [True, True])
                self.assertTrue(all(line['swaras'] == lines[3]['swaras'] for line in lines[4:]))
                self.assertEqual(answer['phrases'], lines[3:])
                self.assertEqual(lines[3]['role'], 'teacher')
                self.assertEqual(lines[4]['role'], 'student')
                self.assertEqual(len({u['voice'] for u in utterances}), 2)
                for clip in lines + utterances:
                    self.assertGreater(rms(clip['start'], clip['end']), 300, clip)
                for first, second in zip(lines[:3], lines[1:4]):
                    self.assertLess(first['end'], second['start'])
                    self.assertGreater(rms(first['end'], second['start']), 60, 'The shruti drone should remain audible between phrases')
                self.assertEqual(answer['song']['start'], lines[0]['start'])
                self.assertAlmostEqual(answer['song']['end'], lines[3]['end'])
                self.assertGreater(lines[4]['start'], answer['song']['end'])
                self.assertGreater(answer['correction']['start'], lines[4]['end'])
                self.assertGreater(lines[5]['start'], answer['correction']['end'])
                if name == 'lesson':
                    first_take = lines[4]['end'] - lines[4]['start']
                    corrected_take = lines[5]['end'] - lines[5]['start']
                    self.assertGreater(corrected_take - first_take, 0.65)
                self.assertIn(answer['correction'], utterances)
                self.assertGreater(answer['duration'], answer['correction']['end'])
                variants.append(answer)
        self.assertEqual(variants[0]['correction']['text'], 'Hold the final note for two counts.')
        self.assertNotEqual(variants[0]['correction']['text'], variants[1]['correction']['text'])
        self.assertGreater(abs(variants[0]['song']['start'] - variants[1]['song']['start']), 2)
        self.assertNotEqual(variants[0]['tonicHz'], variants[1]['tonicHz'])


if __name__ == '__main__':
    unittest.main()
