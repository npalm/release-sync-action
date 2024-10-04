import * as core from '@actions/core'
import { Octokit } from '@octokit/rest'
import { throttling } from '@octokit/plugin-throttling'
import { GetResponseDataTypeFromEndpointMethod } from '@octokit/types'

type Repo = {
  owner: string
  repo: string
}
const ExtendedOctokit = Octokit.plugin(throttling)

const octokit = new ExtendedOctokit({
  auth: process.env.GITHUB_TOKEN,
  // add rate limit plugin
  throttle: {
    onRateLimit: (retryAfter, options, octokit, retryCount) => {
      octokit.log.warn(
        `Request quota exhausted for request ${options.method} ${options.url}`
      )

      if (retryCount < 1) {
        // only retries once
        octokit.log.info(`Retrying after ${retryAfter} seconds!`)
        return true
      }
    },
    onSecondaryRateLimit: (retryAfter, options, octokit) => {
      // does not retry, only logs a warning
      octokit.log.warn(
        `SecondaryRateLimit detected for request ${options.method} ${options.url}`
      )
    }
  }
})

export async function run(): Promise<void> {
  try {
    // get action input delete releases as boolean
    const deleteReleases = core.getInput('delete_releases') === 'false'

    // get source repo as input
    const sourceRepo = core.getInput('source_repo', { required: true })
    // check format of source repo aka owner/repo
    const sourceRepoParts = sourceRepo.split('/')
    if (sourceRepoParts.length !== 2) {
      throw new Error(
        `Invalid source repository format, expected owner/repo, got ${sourceRepo}`
      )
    }

    const startFrom = core.getInput('start_from', { required: false })
    if (startFrom) {
      core.info(`Starting from release ${startFrom}`)
    }

    const source = {
      owner: sourceRepoParts[0],
      repo: sourceRepoParts[1]
    }

    // get target repo as input
    let targetRepo = core.getInput('target_repo') || ''
    // if target repo is not set read it from the context
    if (targetRepo === '') {
      targetRepo = process.env.GITHUB_REPOSITORY || ''
      if (targetRepo === '') {
        throw new Error('GITHUB_REPOSITORY is not set')
      }
    }

    const targetRepoParts = targetRepo.split('/')
    if (targetRepoParts.length !== 2) {
      throw new Error(
        `Invalid target repository format, expected owner/repo, got ${targetRepoParts}`
      )
    }

    const target = {
      owner: targetRepoParts[0],
      repo: targetRepoParts[1]
    }

    // check source and target repos exist
    const sourceExists = await checkRepoExists(source, octokit)
    if (!sourceExists) {
      throw new Error(
        `Source repository ${source.owner}/${source.repo} does not exist`
      )
    }
    const targetExists = await checkRepoExists(target, octokit)
    if (!targetExists) {
      throw new Error(
        `Target repository ${target.owner}/${target.repo} does not exist`
      )
    }

    // get releases from source
    const result = await octokit.paginate(octokit.rest.repos.listReleases, {
      ...source
    })
    core.info(
      `Found ${result.length} releases in ${source.owner}/${source.repo}`
    )

    // create slice of the first 2 of results
    // invert result to get the latest releases first
    result.reverse()

    const releases = result //result.slice(0, 2)

    // download assets for each release in a directory with the release name
    let start = false
    for (const release of releases) {
      if (start || release.tag_name == startFrom) {
        core.info(`Processing release ${release.tag_name}`)
        start = true
      } else {
        core.info(
          `Skipping release ${release.tag_name}, starting from ${startFrom}`
        )
        continue
      }

      await checkRateLimit()

      try {
        const targetRelease = await octokit.rest.repos.getReleaseByTag({
          ...target,
          tag: release.tag_name
        })
        core.info(
          `Release ${release.tag_name} exists in ${target.owner}/${target.repo}`
        )
        if (deleteReleases) {
          core.info(
            `Deleting release ${release.tag_name} in ${target.owner}/${target.repo}`
          )
          await octokit.rest.repos.deleteRelease({
            ...target,
            release_id: targetRelease.data.id
          })
        } else {
          core.info(
            `Skipping release ${release.tag_name} in ${target.owner}/${target.repo}`
          )
          continue
        }
      } catch (error) {
        // ignore
      }

      await copyRelease(target, release)
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message)
    } else {
      core.setFailed(String(error))
    }
  }
}

type ReleaseType = GetResponseDataTypeFromEndpointMethod<
  typeof octokit.rest.repos.createRelease
>

async function checkRateLimit(): Promise<void> {
  const rateLimit = await octokit.rest.rateLimit.get()
  core.info(
    `Rate limit remaining: ${rateLimit.data.rate.remaining}, limit: ${rateLimit.data.rate.limit}`
  )
  if (rateLimit.data.rate.remaining < rateLimit.data.rate.limit * 0.2) {
    throw new Error(
      `Rate limit almost exhausted, remaining: ${rateLimit.data.rate.remaining}, limit: ${rateLimit.data.rate.limit}`
    )
  }
}

async function copyRelease(target: Repo, release: ReleaseType): Promise<void> {
  core.info(
    `Copying release ${release.tag_name} to ${target.owner}/${target.repo}`
  )
  const targetRelease = await octokit.rest.repos.createRelease({
    ...target,
    tag_name: release.tag_name,
    name: release.name as unknown as string,
    body: release.body as unknown as string,
    draft: false,
    prerelease: false
  })

  const assets = await octokit.paginate(octokit.rest.repos.listReleaseAssets, {
    owner: 'philips-labs',
    repo: 'terraform-aws-github-runner',
    release_id: release.id
  })
  // upload assets to target
  for (const asset of assets) {
    const assetContent = await octokit.rest.repos.getReleaseAsset({
      owner: 'philips-labs',
      repo: 'terraform-aws-github-runner',
      asset_id: asset.id,
      headers: {
        Accept: 'application/octet-stream'
      }
    })

    const url = assetContent.url

    // Download file with url
    const response = await fetch(url)
    const arrayBuffer = await response.arrayBuffer()

    // Convert ArrayBuffer to Buffer
    const buffer = Buffer.from(arrayBuffer)

    // Upload the asset to the target
    await octokit.rest.repos.uploadReleaseAsset({
      ...target,
      release_id: targetRelease.data.id,
      name: asset.name,
      data: buffer as unknown as string,
      headers: {
        'Content-Length': assetContent.data.size
      }
    })
  }
}

async function checkRepoExists(repo: Repo, octokit: Octokit): Promise<boolean> {
  try {
    await octokit.rest.repos.get({
      ...repo
    })
    return true
  } catch {
    return false
  }
}
