Scaffolding for the emulator-backed integration test.

`firestore.rules` is **not** committed and not written by hand: `journey.mjs`
copies it out of `@hushjot/core/contract/firestore.rules` before the emulator
starts, so the test always runs against the rules the installed core shipped
rather than a vendored copy that can quietly fall behind.

The ports are 9099/8086 rather than the app repo's 9098/8085 so that a running
`npm run emulators` in the app checkout does not collide with a test run here.
