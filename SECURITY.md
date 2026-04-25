# Security Policy

## Supported Versions

Security fixes target the latest published version of `langchain-codex`.

This package is pre-1.0, so compatibility may change between minor releases. Security fixes may require upgrading to the latest minor version.

## Reporting a Vulnerability

Please do not open a public issue for a suspected vulnerability.

Report security issues through GitHub's private vulnerability reporting for this repository. If that is unavailable, contact the maintainer directly through GitHub.

Include:

- affected version
- description of the issue
- reproduction steps or proof of concept
- potential impact
- any known mitigations

## Scope

This package wraps the local Codex runtime. Reports about unsafe behavior should distinguish between:

- vulnerabilities in this adapter
- expected Codex local-agent behavior configured by sandbox or approval settings
- vulnerabilities in upstream dependencies such as `@openai/codex-sdk` or `@langchain/core`

