# yourga.me

**What if collective intelligence produced a game?**

**English** · [한국어](README.ko.md)

[Visit yourga.me](https://yourga.me/?lang=en) · [Development log](CHANGELOG.md) · [Contributing](CONTRIBUTING.md)

Wikipedia shows what people can build when they bring their knowledge together. **yourga.me asks what would happen if that shared effort became a game:** a world shaped by many people's ideas, evolving into something no single person would have designed alone.

This project was inspired by [Everyone Draw](https://everyonedraw.com/). Its shared drawing canvas prompted a different question: what could we create together if the canvas were a playable game?

yourga.me is an independent experiment; this inspiration does not imply affiliation with or endorsement by Everyone Draw or Wikipedia.

## How it works

1. **Propose.** Suggest a character, rule, encounter, mechanic, or change to the world.
2. **Vote.** Read other people's proposals and vote to help shape the direction.
3. **Build and review.** Approved requirements go through a five-role game workflow covering orchestration, scenario, art, gameplay, and assets. The operator checks safety, implementation, and playability before release.
4. **Play and repeat.** Play the evolving solo roguelike, see what changed, and suggest its next direction.

Collective creation does not mean every proposal is automatically implemented. Conflicting ideas, technical limits, content safety, and a coherent game all matter. Public proposals are product input, never permission to execute commands, access secrets, or publish a release.

## The project today

The repository contains the website, server APIs, game runtime and versioned game data, tests, project decisions, and operational runbooks.

- A **9:16 mobile roguelike**, with desktop keyboard and mobile touch controls.
- **English by default, with Korean support.** The website can initially select Korean for visitors in Korea; a manual language choice takes precedence.
- Google sign-in for participation, public ideas, voting, editable public names, and contribution leaderboards.
- Up to three new proposals per rolling 60 minutes, limited to 2,000 UTF-8 bytes each. Editing an eligible proposal does not use another submission.
- Version-specific local saves, reviewed game publication, and a fallback to the last verified game when a candidate fails.
- A daily target of **23:00 KST for collecting that day's ideas and the next midnight for release**, subject to review and validation. This is a target, not a guarantee of an on-time release.
- A Teen content ceiling as a design constraint, **not an official ESRB rating**.

The first game implementation, `v1-20260901`, is included in the repository. Files in Git, a successful build, or a countdown reaching zero do not prove that a game has been released. The live selection and operator verification determine release status. Contribution points likewise require verified implementation and release evidence; the leaderboard alone is not evidence of awarded points.

## Run locally

Use **Node.js 22** and npm. Start with a local database; do not copy production credentials into development.

```sh
git clone https://github.com/hongwoogi/yourgame.git
cd yourgame
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The development server defaults to `.local/development.db` and prepares its schema on first connection. Google sign-in needs your own Google web client configuration: copy `.env.example` to the ignored `.env.local` and fill in the relevant settings. Without that configuration, you can inspect the interface, but real Google sign-in is unavailable.

Schema preparation does not activate every community policy or publish a game. A fresh checkout can show an empty or preparation state. See the [launch runbook](docs/launch-runbook.md) for explicit local setup and operator procedures; do not run production commands just to preview the interface.

```sh
npm run build
npx playwright install chromium
npm run test:ui
```

`npm run build` checks source syntax, required assets, translation keys, and the backend/core test suite. UI tests exercise desktop and mobile behavior with Playwright. Their simulated Google responses do **not** verify a real Google account login. Before an application deployment, install and build a fresh `git archive` as described in the runbook.

## Repository map

| Path | Purpose |
| --- | --- |
| `public/` | Website, translations, isolated game runtime, and reviewed versioned game assets |
| `api/`, `server/` | HTTP handlers, authentication, proposals, votes, and release controls |
| `scripts/` | Local development, validation, and trusted operator tools |
| `tests/` | Backend, game rules, security boundaries, and browser regression checks |
| `.codex/agents/` | Definitions for the five game-development roles |
| `docs/` | Design decisions, feature contracts, and operational procedures |
| `CHANGELOG.md` | Public English/Korean development record |
| `.local/` | Ignored local databases, raw logs, and private verification records |

The existing stack uses JavaScript modules, Vercel hosting, Turso data storage, a Cloudflare-managed domain, and the operator's local Codex workflow. Publishing this repository does not grant access to those accounts or production data.

Scheduled local work requires the operator's PC and Codex app to be running. Network, application, or usage limits can delay a run; failed validation leaves the last verified game in place.

## Development in public

We record meaningful changes, the reason for them, validation results, and known limitations in the bilingual [development log](CHANGELOG.md). Git history preserves the detailed code changes. Future contributions should update the log and keep both READMEs aligned.

**Public project history is separate from private operational logs.** Credentials, environment files, cookies, tokens, participant records, raw proposal exports, database copies, and private review evidence must stay out of Git. Operational evidence belongs in ignored `.local/` storage. Public logs should contain only sanitized summaries; never paste raw production output into an issue or pull request.

## Further reading

Most detailed project documents are currently in Korean; the two READMEs cover the same introduction and setup.

- [Design and decisions](docs/design.md)
- [Game team workflow](docs/game-agent-workflow.md)
- [Game runtime contract](docs/game-runtime-contract.md)
- [Participation safety](docs/participation-safety.md)
- [Voting and contribution rules](docs/voting-and-contribution.md)
- [Language support](docs/localization.md)
- [Launch and recovery runbook](docs/launch-runbook.md)
- [Daily collection and release procedure](docs/daily-release-runbook.md)
- [Historical infrastructure verification](docs/infrastructure-status.md)

## License

The source is publicly visible, but no open-source license has been selected yet. Public visibility does not itself grant a general license to reuse or redistribute the project. Third-party dependencies retain their own licenses.
