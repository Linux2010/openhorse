# OpenHorse Documentation

## Directory Structure

```
docs/
├── readme.md                  # This file
├── openhorse.example.json     # Example configuration
├── general-configuration-reference.md  # Configuration reference
├── AGENT.md                   # Agent instructions
│
├── product-plan/              # Product planning & strategy
│   ├── 00-索引与执行摘要.md
│   ├── 01-现状能力分析.md
│   ├── 02-竞品调研.md
│   ├── 03-新版本功能规划.md
│   ├── 04-技术选型论证.md
│   └── 05-开发路线图.md
│
├── targets/                   # Vision & target state docs
│   ├── general-coding-agent-vision-reference.md
│   ├── general-ui-runtime-boundary-reference.md
│   ├── general-agent-loop-final-form-reference.md
│   └── general-ui-ultimate-experience-reference.md
│
├── codex/                     # Architecture & design plans (v0.1.x - v0.2.x)
│   ├── general-*.md           # Cross-version design docs
│   └── v0.2.*.md              # Per-version plans & audits
│
├── test/                      # Test plans & reports
│   ├── general-*.md           # General testing strategy
│   ├── v0.*.md                # Per-version test plans/reports
│   ├── 10-test-prompts-*.md   # Test prompt suites
│   ├── logs/                  # Test execution logs
│   └── runs/                  # Test run artifacts
│
├── version/                   # Release changelogs & quality reviews
│   └── v0.*.md
│
├── claude/                    # Claude-specific early design docs (v0.2.4-v0.2.7)
│   └── v0.2.*.md
│
├── agy/                       # AGY-related proposals & supplements
│   └── *.md
│
├── workBuddy/                 # WorkBuddy bug reports & fix plans
│   └── *.md
│
└── old/                       # Archived — pre-v0.2 early docs
    ├── general-*.md
    ├── v0.1.*.md
    └── issues/
```

## Directory Purpose

| Directory | Purpose | Active? |
|-----------|---------|---------|
| `product-plan/` | Product strategy, competitive analysis, roadmap | Yes |
| `targets/` | Long-term vision and target state references | Yes |
| `codex/` | Architecture plans, design docs, audits per version | Yes |
| `test/` | Test plans, reports, prompt suites, logs | Yes |
| `version/` | Release changelogs and quality review notes | Yes |
| `claude/` | Early v0.2.4-v0.2.7 design docs (Claude-specific) | Frozen |
| `agy/` | AGY technical upgrade proposals | Frozen |
| `workBuddy/` | WorkBuddy bug reports and fix assessments | Frozen |
| `old/` | Pre-v0.2 changelogs and early implementation plans | Archived |

## Naming Convention

```
{scope}-{topic}-{type}.md
```

- **scope**: `general` (cross-version) or `v0.2.X` (version-specific)
- **topic**: short kebab-case description
- **type**: `plan`, `report`, `audit`, `reference`, `changelog`

Examples:
- `v0.2.26-multi-model-configuration-plan.md` — version-specific design plan
- `general-mcp-integration-design.md` — cross-version reference
- `v0.2.24-v0.2.26-integration-audit.md` — multi-version audit

## File Migration Plan

The following files need to be moved to align with this structure:

| Current Path | Target Path | Reason |
|-------------|-------------|--------|
| `docs/codex/v0.2.4-*` | → `docs/claude/` | Already in claude/, remove from codex |
| `docs/codex/v0.2.6-*` | → `docs/claude/` | Already in claude/, remove from codex |
| `docs/codex/v0.2.7-*` | → `docs/claude/` | Already in claude/, remove from codex |
| `docs/codex/v0.1.23-*` | → `docs/old/` | Pre-v0.2, archive |
| `docs/claude/v0.2.4-*` | Keep | Correct location |
| `docs/claude/v0.2.6-*` | Keep | Correct location |
| `docs/claude/v0.2.7-*` | Keep | Correct location |

## Adding New Docs

1. Determine if the doc is **version-specific** or **cross-version**
2. Pick the right directory based on the table above
3. Use the naming convention
4. For new versions, place plans/audits in `codex/`, test docs in `test/`, changelogs in `version/`