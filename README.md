# Sync release branches

> EXPERIMENTAL: This is an experimental repository

Action to sync release between repositories.

## Usages

### Via command line

````bash
npm install
export INPUT_GITHUB_TOKEN=your_github_token
export INPUT_SOURCE_REPO=source_repository
export INPUT_TARGET_REPO=target_repository
npm run serve:watch

### Via GitHub Actions

```yaml
name: Sync release branches

on:
  dispatch:

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - name: Sync release branches
        uses: ./
        with:
          githubToken: ${{ secrets.GITHUB_TOKEN }}
          sourceRepo: owner/repo
          targetRepo: owner/repo
````
