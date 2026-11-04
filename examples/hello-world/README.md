# Hello World

This dependency-free Node.js 22 CLI is a small example for validating the Engineering Crew delivery workflow.

- With no arguments, it writes `Hello, World!` and a newline to stdout.
- With one argument, it uses the supplied name verbatim. Shell quotes keep a name with spaces in one argument.
- With two or more arguments, it prints usage to stderr, leaves stdout empty, and exits with status 1.

From this directory, run the CLI and its tests with Node.js 22.

```sh
node hello.mjs
node hello.mjs Ada
node hello.mjs "Ada Lovelace"
node --test hello.test.mjs
```
