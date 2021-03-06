#!/usr/bin/env node

import { Session } from 'inspector'
import { sep as pathSep } from 'path'
import { writeFile, readdir, stat, unlink } from 'fs'
import { join } from 'path'
import { performance } from 'perf_hooks'
import { Configure } from '../lib/configure.js'
import { AssertionError } from 'assert'

/** @typedef {{String: {function: Function, skipped: Boolean}}} TestAssertions */
/** @typedef {{id: String, assertions: TestAssertions}} TestModules */
/** @typedef {{testModuleId: String, assertionId: String, result: Boolean, skipped: Boolean}} AssertionResult */
/** @typedef {import('../lib/logger/testLogger.js').TestLogger} TestLogger */

/**
 * @param {Session} session
 */
async function StartCoverage(session) {
  await new Promise((resolve, reject) =>
    session.post('Profiler.enable', {}, err =>
      err ? reject(err) : resolve(null)
    )
  )
  await new Promise((resolve, reject) =>
    session.post(
      'Profiler.startPreciseCoverage',
      {
        callCount: true,
        detailed: true,
      },
      err => (err ? reject(err) : resolve(null))
    )
  )
}

async function ClearCoverageDirectory(coverageDir) {
  /** @type {string[]} */
  let entries = []
  try {
    entries = await new Promise((resolve, reject) => {
      readdir(coverageDir, (err, entries) =>
        err ? reject(err) : resolve(entries)
      )
    })
  } catch (err) {
    logger.Error(err)
  }

  for (const eachEntry of entries) {
    if (eachEntry === '.gitignore') continue
    const coverageFile = join(coverageDir, eachEntry)
    logger.Debug(`Removing ${coverageFile}`)
    try {
      await new Promise((resolve, reject) => {
        unlink(coverageFile, err => (err ? reject(err) : resolve(null)))
      })
    } catch (err) {
      logger.Error(err)
      return
    }
  }
}

/**
 * @param {Session} session
 * @param {TestLogger} logger
 * @param {String} coverageDir
 * @param {Boolean} clearCoverage
 */
async function WriteCoverageResults(
  session,
  logger,
  coverageDir,
  clearCoverage
) {
  /** @type {import('inspector').Profiler.TakePreciseCoverageReturnType?} */
  let data = null
  try {
    data = await new Promise((resolve, reject) => {
      session?.post('Profiler.takePreciseCoverage', (err, data) =>
        err ? reject(err) : resolve(data)
      )
    })
  } catch (err) {
    logger.Error(err)
  }
  if (data === null) return

  clearCoverage && ClearCoverageDirectory(coverageDir)

  const coverageFile = `${coverageDir}${pathSep}coverage-${Date.now()}.json`
  logger.Debug(`Writing ${coverageFile}`)
  try {
    await new Promise((resolve, reject) => {
      writeFile(coverageFile, JSON.stringify(data), err =>
        err ? reject(err) : resolve(null)
      )
    })
  } catch (err) {
    logger.Error(err)
  }
}

/**
 * @param {TestModules[]} testModules
 * @param {Configure} config
 *
 * @returns {Promise<[AssertionResult[], number]>}
 */
async function RunTests(testModules, config) {
  /** @type {AssertionResult[]}} */
  const assertions = []
  const initialTime = performance.now()
  for (const eachTestModule of testModules) {
    for (const eachAssertionId in eachTestModule.assertions) {
      assertions.push(
        new Promise(async (resolve, reject) => {
          eachTestModule.setUp()
          const skipped =
            config.dryRun ||
            eachTestModule.assertions[eachAssertionId].skip ||
            false

          let result = skipped || true
          if (!skipped) {
            try {
              await eachTestModule.assertions[eachAssertionId].function()
            } catch (err) {
              if (err instanceof AssertionError) {
                result = false
                config.logger.Error(err)
              } else {
                reject(err)
              }
            }
          }
          eachTestModule.tearDown()
          resolve({
            testModuleId: eachTestModule.id,
            assertionId: eachAssertionId,
            result: result,
            skipped: skipped,
          })
        })
      )
    }
  }

  return [await Promise.all(assertions), performance.now() - initialTime]
}

/**
 * @param {String} dir
 * @param {TestLogger} logger
 *
 * @returns {Promise<String[]>}
 */
function GetEntries(dir, logger) {
  logger.Debug(`Looking in: ${dir}`)
  try {
    return new Promise((resolve, reject) => {
      readdir(dir, (err, entries) => (err ? reject(err) : resolve(entries)))
    })
  } catch (error) {
    logger.Error(error)
    return Promise.resolve([])
  }
}

/**
 * @param {String} path
 * @param {TestLogger} logger
 *
 * @returns {Promise<import('fs').Stats?>}
 */
function GetEntryStats(path, logger) {
  try {
    return new Promise((resolve, reject) => {
      stat(path, (err, stats) => (err ? reject(err) : resolve(stats)))
    })
  } catch (error) {
    logger.Error(error)
    return Promise.resolve(null)
  }
}

/**
 * @param {String} dir
 * @param {TestLogger} logger
 * @param {String[]} excludeDirs
 * @param {TestModule[]} testModules
 */
async function FindTestModules(dir, logger, excludeDirs, testModules) {
  let functionFinished = []
  for (const eachEntry of await GetEntries(dir, logger)) {
    const fullPath = join(dir, eachEntry)
    const entryStats = await GetEntryStats(fullPath, logger)
    if (entryStats?.isDirectory()) {
      if (excludeDirs.indexOf(fullPath) >= 0) {
        logger.Debug(`${fullPath} is excluded. Skipping...`)
        continue
      }
      functionFinished.push(
        new Promise(resolve =>
          resolve(FindTestModules(fullPath, logger, excludeDirs, testModules))
        )
      )
    }  else if (eachEntry.split('.').pop() === "js") {
      logger.Debug(`Found file: ${fullPath}`)
      /** @type {TestModule} */
      let module
      try {
        module = await import(fullPath.replace(/\\/g, '/').replace(/c:/gi, ''))
      } catch (error) {
        logger.Error(`Error importing: ${fullPath}: ${error}`)
        logger.Error('Skipping...')
        continue
      }

      if (module['assertions']) {
        if (!module['id']) module = { ...module, id: eachEntry }
        if (!module['setUp']) module = { ...module, setUp: () => {} }
        if (!module['tearDown']) module = { ...module, tearDown: () => {} }
        logger.Debug(`Found module: ${module['id']}`)
        testModules.push(module)
      }
    }
  }
  await Promise.all(functionFinished)
}

async function jester() {
  const config = new Configure()
  config.exitAfter && process.exit(config.exitCode)

  /** @type {TestModule[]} */
  let testModules = []
  try {
    for (let eachDirectory of config.testDirs) {
      await FindTestModules(
        join(process.cwd(), eachDirectory),
        config.logger,
        config.excludeDirs,
        testModules
      )
    }
  } catch (error) {
    config.logger.Error(error)
    process.exit(-1)
  }

  const session = new Session()
  session.connect()
  config.coverageEnabled && (await StartCoverage(session))

  /** @type {AssertionResult[]} */
  let assertionResults = []
  let testingTime = 0.0
  try {
    [assertionResults, testingTime] = await RunTests(testModules, config)
  } catch (error) {
    config.logger.Error(error)
    process.exit(-1)
  }

  config.coverageEnabled &&
    (await WriteCoverageResults(
      session,
      config.logger,
      config.coverageDir,
      config.clearCoverage
    ))
  session.disconnect()

  const moduleResults = {}
  for (const eachAssertionResult of assertionResults) {
    if (!moduleResults.hasOwnProperty(eachAssertionResult.testModuleId))
      moduleResults[eachAssertionResult.testModuleId] = { assertionResults: [] }

    moduleResults[eachAssertionResult.testModuleId].assertionResults.push(
      eachAssertionResult
    )
  }

  let failedModules = 0
  for (const [id, result] of Object.entries(moduleResults)) {
    config.logger.WriteModuleHead(id)
    let failedAssertions = 0

    for (const eachAssertionResult of result.assertionResults) {
      if (!eachAssertionResult.result) failedAssertions++
      config.logger.WriteAssertionResult(
        eachAssertionResult.result,
        eachAssertionResult.assertionId,
        eachAssertionResult.skipped
      )
    }

    if (failedAssertions > 0) failedModules++
    config.logger.WriteModuleSummary(
      id,
      result.assertionResults.length,
      failedAssertions
    )
  }

  config.logger.WriteTestingSummary(
    testingTime,
    failedModules,
    testModules.length
  )
  process.exitCode = failedModules
}

jester()
