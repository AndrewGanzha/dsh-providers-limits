// Client-half tests: load client.js through a fake ModuleLoader with a minimal
// React shim, then check the module id and slot registrations.
//
//   node --test          (CI)
//   node test/client.test.mjs  (single file)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

function loadClientModule() {
  let definition
  globalThis.window = { __ModuleLoader__: { load: (value) => { definition = value } } }
  // eslint-disable-next-line no-eval
  const source = readFileSync(join(root, 'client.js'), 'utf8')
  // The bundle is a plain script that expects window.__ModuleLoader__.
  new Function('window', source)(globalThis.window)
  assert.ok(definition, 'client bundle did not call __ModuleLoader__.load')

  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
  }
  const required = []
  const module = definition.factory((name) => {
    required.push(name)
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
  return { definition, module, required }
}

test('client module id matches the package name', () => {
  const { definition } = loadClientModule()
  assert.equal(definition.id, pkg.name)
})

test('apply registers the dock and the details overlay', () => {
  const { module } = loadClientModule()
  const calls = []
  const ctx = {
    slots: {
      inject(name, factory) {
        calls.push(['inject', name])
        factory()
      },
      register(options, component) {
        calls.push(['register', options.name, options.id, options.order, typeof component])
        return () => {}
      },
    },
  }
  assert.deepEqual(module.inject, ['slots'])
  module.apply(ctx)
  assert.deepEqual(calls, [
    ['inject', 'conversation.composer.dock'],
    ['register', 'conversation.composer.dock', 'provider-limits', 5, 'function'],
    ['inject', 'shell.overlay'],
    ['register', 'shell.overlay', 'provider-limits.details', undefined, 'function'],
  ])
})

test('details render nothing while closed', () => {
  const { module } = loadClientModule()
  let Details
  module.apply({
    slots: {
      inject: (_name, factory) => factory(),
      register: (options, component) => {
        if (options.name === 'shell.overlay') Details = component
        return () => {}
      },
    },
  })
  assert.equal(typeof Details, 'function')
  assert.equal(Details(), null)
})

test('patch row and client id agree with the package name', () => {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, new RegExp(`name: '${pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`))
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(pkg.exports['./client'])
})
