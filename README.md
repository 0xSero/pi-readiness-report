# pi-readiness-report

Global pi extension that generates a Factory-style readiness report with scores, analytics, and HTML/Markdown outputs.

## Install (Global Extension)

```bash
mkdir -p ~/.pi/agent/extensions/readiness-report
cp readiness-report.ts ~/.pi/agent/extensions/readiness-report/index.ts
```

Restart pi to load the extension.

## Usage

Run inside a repo:

```
/readiness-report
```

Optional model override for the narrative summary:

```
/readiness-report model=provider/id
# or
/readiness-report --model provider/id
```

## Outputs

Reports are written to:

```
.pi/reports/readiness-report-<timestamp>/
  readiness-report.html
  readiness-report.md
  readiness-report.json
```

## Notes

- The extension infers criteria based on repo signals and produces N/A when checks are not applicable.
- HTML uses the Warm Paper Design System and includes charts for pass rate by category and level over time.
- The narrative summary uses the active/last-selected model (or the explicit model argument).
