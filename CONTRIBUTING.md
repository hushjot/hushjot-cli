# Contributing

Bug reports and pull requests are welcome. For anything larger than a fix,
open an issue first, so we can agree the approach before you spend time on it.

Set up as in the README's Install section, with the app cloned beside this
repository. Then, before you open a pull request:

```bash
npm run check
npm test
npm run test:integration   # needs the Firebase CLI and Java
```

- **Never reimplement the format.** Titles, the envelope, the tokeniser and
  the search grammar come from `@hushjot/core`. Something the CLI needs that
  core does not export is added to the app's `src/core/public.ts` first.
- **Nothing may destroy text.** There is no delete verb, and that is on
  purpose.
- **Explain the why.** Modules open with a comment that gives the reasons for
  their design. Update that comment when you change what it describes.
- Two-space indentation, single quotes, semicolons, explicit `.ts` import
  extensions.

`CLAUDE.md` is the detailed architecture guide, written for humans and coding
agents alike.

## Licence

By contributing, you agree that your contribution is licensed under the
AGPL-3.0-only licence of this project.
