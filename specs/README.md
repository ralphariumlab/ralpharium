# Specs

One Markdown file per requirement / feature / acceptance criterion.

Ralpharium reads every `specs/*.md` file and maps it against the plan
and recent commits. Each spec gets one of four statuses on the
dashboard:

- **covered**  — referenced in the plan AND in a recent commit
- **partial**  — referenced in the plan or tasks only
- **drifting** — touched by commits but not in the plan
- **ignored**  — never referenced anywhere

Filenames matter. `specs/auth-session-refresh.md` is matched against
the tokens `auth` / `session` / `refresh` in plan task text and
commit subjects. Use kebab-case names that the runner is likely to
mention naturally.

## How to write a spec

Keep specs short. They're read by humans first, runners second.
Use this outline:

```markdown
# <Title>

## Problem
What is broken / missing / unclear today? Why does it matter?

## User story
As a <role>, I want <capability>, so that <outcome>.

## Acceptance criteria
- [ ] Concrete, observable behavior #1
- [ ] Concrete, observable behavior #2
- [ ] Concrete, observable behavior #3

## Non-goals
What this spec is *not* trying to do. Things runners should NOT add
under the banner of this spec.

## Validation
How do we know it works? Reference the test files / commands that
confirm each acceptance criterion.
```

## Example

A minimal spec for a session-refresh feature:

```markdown
# Auth: refresh session on 401

## Problem
Users get logged out mid-session because the front-end never
attempts to refresh their token.

## User story
As a signed-in user, when my access token expires, I want the app
to refresh it transparently so I don't have to log in again.

## Acceptance criteria
- [ ] On a 401 from /api/*, the client posts to /api/auth/refresh.
- [ ] On 200 from refresh, the original request is retried once.
- [ ] On non-200 from refresh, the user is redirected to /login.

## Non-goals
- Server-side session storage redesign.
- Multi-device session listing.

## Validation
- `npm test -- auth/refresh.test.ts` passes.
- Manual: open dashboard, force token expiry, see app stay signed in.
```
