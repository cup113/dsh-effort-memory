/**
 * One in-process test entry point.
 *
 * `node --test` is deliberately not used: it runs each test file in a child
 * process with piped stdio, which a confined sandbox refuses (`spawn EPERM`).
 * Importing the suites runs their `test()` registrations in this process
 * instead, and the exit code still reflects failures.
 *
 * Run: node test/all.mjs
 */
import './decide.test.mjs'
import './apply.test.mjs'
