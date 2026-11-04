# Pet store catalog brief

A visitor wants to see the available pets from the Hello World CLI. Propose
reserving `--list-pets` as a single argument. The output should be a JSON array
with Mochi the cat followed by Pip the dog, using `name` and `species` fields.
The exact JSON value is `[{"name":"Mochi","species":"cat"},{"name":"Pip","species":"dog"}]`.
Whitespace inside the JSON is flexible. The catalog uses fictional data.

- `CAT-1` covers catalog output on stdout, its final newline, empty stderr, and
  exit status 0.
- `CAT-2` covers greetings with no argument, one ordinary name, and a quoted
  name containing spaces. Successful greetings use stdout with a final newline,
  empty stderr, and exit status 0.
- `CAT-3` covers the existing usage error with two or more arguments, including
  a catalog flag followed by an extra argument. Expect empty stdout,
  `Usage: node hello.mjs [name]` plus a newline on stderr, and exit status 1.

The proposed change is to the CLI only. Review the criteria before the crew
builds the catalog command.
