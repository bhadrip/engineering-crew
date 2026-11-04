const [name = 'World', ...extraArguments] = process.argv.slice(2);

if (extraArguments.length > 0) {
  console.error('Usage: node hello.mjs [name]');
  process.exitCode = 1;
} else if (name === '--list-pets') {
  console.log(JSON.stringify([
    { name: 'Mochi', species: 'cat' },
    { name: 'Pip', species: 'dog' },
  ]));
} else {
  console.log(`Hello, ${name}!`);
}
