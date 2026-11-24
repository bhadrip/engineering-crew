export function musicProfile(existing, { exists }) {
  const config = { ...existing, image: 'engineering-crew-music:local', acceptance: 'carnatic-lesson' };
  if (!exists) {
    config.roles = Object.fromEntries(['planner', 'engineer', 'reviewer', 'security', 'qa']
      .map(role => [role, { model: 'gpt-6-luna' }]));
  }
  return config;
}
