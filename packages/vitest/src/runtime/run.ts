import { performance } from 'perf_hooks'
import inspector from 'inspector'
import type { HookListener, ResolvedConfig, Suite, SuiteHooks, Task, TaskResult, Test } from '../types'
import { vi } from '../integrations/vi'
import { getSnapshotClient } from '../integrations/snapshot/chai'
import { getFullName, hasFailed, hasTests, partitionSuiteChildren } from '../utils'
import { getState, setState } from '../integrations/chai/jest-expect'
import { getFn, getHooks } from './map'
import { rpc } from './rpc'
import { collectTests } from './collect'
import { processError } from './error'

export async function callSuiteHook<T extends keyof SuiteHooks>(suite: Suite, name: T, args: SuiteHooks[T][0] extends HookListener<infer A> ? A : never) {
  if (name === 'beforeEach' && suite.suite)
    await callSuiteHook(suite.suite, name, args)

  await Promise.all(getHooks(suite)[name].map(fn => fn(...(args as any))))

  if (name === 'afterEach' && suite.suite)
    await callSuiteHook(suite.suite, name, args)
}

const packs = new Map<string, TaskResult|undefined>()
let updateTimer: any
let previousUpdate: Promise<void>|undefined

function updateTask(task: Task) {
  packs.set(task.id, task.result)

  clearTimeout(updateTimer)
  updateTimer = setTimeout(() => {
    previousUpdate = sendTasksUpdate()
  }, 10)
}

async function sendTasksUpdate() {
  clearTimeout(updateTimer)
  await previousUpdate

  if (packs.size) {
    const p = rpc().onTaskUpdate(Array.from(packs))
    packs.clear()
    return p
  }
}

export async function runTest(test: Test) {
  if (test.mode !== 'run')
    return

  const start = performance.now()

  test.result = {
    state: 'run',
  }
  updateTask(test)

  clearModuleMocks()

  getSnapshotClient().setTest(test)

  process.__vitest_worker__.current = test

  try {
    await callSuiteHook(test.suite, 'beforeEach', [test, test.suite])
    setState({
      assertionCalls: 0,
      isExpectingAssertions: false,
      isExpectingAssertionsError: null,
      expectedAssertionsNumber: null,
      expectedAssertionsNumberError: null,
      testPath: test.suite.file?.filepath,
      currentTestName: getFullName(test),
    })
    await getFn(test)()
    const { assertionCalls, expectedAssertionsNumber, expectedAssertionsNumberError, isExpectingAssertions, isExpectingAssertionsError } = getState()
    if (expectedAssertionsNumber !== null && assertionCalls !== expectedAssertionsNumber)
      throw expectedAssertionsNumberError
    if (isExpectingAssertions === true && assertionCalls === 0)
      throw isExpectingAssertionsError

    test.result.state = 'pass'
  }
  catch (e) {
    test.result.state = 'fail'
    test.result.error = processError(e)
  }

  try {
    await callSuiteHook(test.suite, 'afterEach', [test, test.suite])
  }
  catch (e) {
    test.result.state = 'fail'
    test.result.error = processError(e)
  }

  // if test is marked to be failed, flip the result
  if (test.fails) {
    if (test.result.state === 'pass') {
      test.result.state = 'fail'
      test.result.error = processError(new Error('Expect test to fail'))
    }
    else {
      test.result.state = 'pass'
      test.result.error = undefined
    }
  }

  getSnapshotClient().clearTest()

  test.result.duration = performance.now() - start

  process.__vitest_worker__.current = undefined

  updateTask(test)
}

export async function runSuite(suite: Suite) {
  if (suite.result?.state === 'fail')
    return

  const start = performance.now()

  suite.result = {
    state: 'run',
  }

  updateTask(suite)

  if (suite.mode === 'skip') {
    suite.result.state = 'skip'
  }
  else if (suite.mode === 'todo') {
    suite.result.state = 'todo'
  }
  else {
    try {
      await callSuiteHook(suite, 'beforeAll', [suite])

      for (const tasksGroup of partitionSuiteChildren(suite)) {
        if (tasksGroup[0].concurrent === true) {
          await Promise.all(tasksGroup.map(c => runSuiteChild(c)))
        }
        else {
          for (const c of tasksGroup)
            await runSuiteChild(c)
        }
      }

      await callSuiteHook(suite, 'afterAll', [suite])
    }
    catch (e) {
      suite.result.state = 'fail'
      suite.result.error = processError(e)
    }
  }
  suite.result.duration = performance.now() - start

  if (suite.mode === 'run') {
    if (!hasTests(suite)) {
      suite.result.state = 'fail'
      if (!suite.result.error)
        suite.result.error = new Error(`No tests found in suite ${suite.name}`)
    }
    else if (hasFailed(suite)) {
      suite.result.state = 'fail'
    }
    else {
      suite.result.state = 'pass'
    }
  }

  updateTask(suite)
}

async function runSuiteChild(c: Task) {
  return c.type === 'test'
    ? runTest(c)
    : runSuite(c)
}

export async function runSuites(suites: Suite[]) {
  for (const suite of suites)
    await runSuite(suite)
}

export async function startTests(paths: string[], config: ResolvedConfig) {
  const files = await collectTests(paths, config)

  rpc().onCollected(files)

  let session!: inspector.Session
  if (config.coverage.enabled) {
    inspector.open(0)
    session = new inspector.Session()
    session.connect()

    session.post('Profiler.enable')
    session.post('Profiler.startPreciseCoverage', { detailed: true })
  }

  await runSuites(files)

  if (config.coverage.enabled) {
    session.post('Profiler.takePreciseCoverage', (_, coverage) => {
      rpc().coverageCollected(coverage)
    })

    session.disconnect()
    try {
      inspector.close()
    }
    catch {
      // Fails inside workers for some reason
    }
  }

  await getSnapshotClient().saveSnap()

  await sendTasksUpdate()
}

export function clearModuleMocks() {
  const { clearMocks, mockReset, restoreMocks } = process.__vitest_worker__.config

  // since each function calls another, we can just call one
  if (restoreMocks)
    vi.restoreAllMocks()
  else if (mockReset)
    vi.resetAllMocks()
  else if (clearMocks)
    vi.clearAllMocks()
}
