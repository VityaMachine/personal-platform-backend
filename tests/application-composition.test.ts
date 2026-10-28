import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { readApplicationConfig } from "../src/config/config";

// Fresh processes keep module interception isolated from the HTTP/runner tests.
function probe(script: string) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const originalLoad = Module._load;
    const resolve = (request, parent) => Module._resolveFilename(request, parent).replaceAll('\\\\', '/');
    (async () => { ${script} })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { encoding: "utf8", timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.error, undefined);
}

test("application config retains runtime defaults and explicit overrides", () => {
  assert.deepEqual(readApplicationConfig({}), {
    port: 4000, clientOrigin: "http://localhost:3000", runner: { enabled: true, intervalMs: 300_000 },
  });
  assert.deepEqual(readApplicationConfig({ PORT: "4567", CLIENT_ORIGIN: "https://client.example",
    ROUTINE_AUTO_GENERATION_ENABLED: "false", ROUTINE_AUTO_GENERATION_INTERVAL_MS: "1500" }), {
    port: 4567, clientOrigin: "https://client.example", runner: { enabled: false, intervalMs: 1500 },
  });
});

test("isolated app import creates no app, Prisma/connection, logger, runner, timers or signal handlers and loads no dotenv", () => {
  probe(`
    const express = require('express');
    require('cors');
    // Compile before instrumenting timers: tsx itself starts a transform-cache timer.
    const ts = require('typescript');
    const appFilename = require.resolve('./src/app.ts');
    const compiled = ts.transpileModule(require('node:fs').readFileSync(appFilename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const originalExtension = Module._extensions['.ts'];
    Module._extensions['.ts'] = function(loaded, filename) {
      if (filename === appFilename) return loaded._compile(compiled, filename);
      return originalExtension(loaded, filename);
    };
    const calls = { app: 0, prisma: 0, connection: 0, runner: 0, logger: 0, timer: 0, listen: 0, signal: 0, dotenv: 0 };
    const fail = key => () => { calls[key]++; throw Error('Unexpected ' + key); };
    express.application.listen = fail('listen');
    for (const name of ['setTimeout', 'setInterval', 'setImmediate']) global[name] = fail('timer');
    for (const name of ['on', 'once', 'addListener']) {
      const original = process[name];
      process[name] = function(event, ...args) {
        if (['SIGINT', 'SIGTERM'].includes(event)) return fail('signal')();
        return original.call(this, event, ...args);
      };
    }
    Module._load = function(request, parent, main) {
      if (request === 'express') return new Proxy(express, { apply: fail('app') });
      if (request.startsWith('dotenv')) return fail('dotenv')();
      if (request === 'pg' || request === '@prisma/adapter-pg') return fail('connection')();
      const filename = resolve(request, parent);
      if (filename.endsWith('/infrastructure/database/prisma.ts')) return { getPrisma: fail('prisma') };
      if (filename.includes('/generated/prisma/')) return { PrismaClient: class { constructor() { fail('prisma')(); } } };
      if (filename.endsWith('/routines.runner.ts')) return { createRoutineRunner: fail('runner') };
      if (filename.endsWith('/logging/logger.ts')) return { createLogger: fail('logger') };
      return originalLoad.apply(this, arguments);
    };
    const imported = require('./src/app.ts');
    assert.equal(typeof imported.createApp, 'function');
    assert.equal('app' in imported, false);
    assert.deepEqual(Object.values(calls), Array(9).fill(0));
  `);
});

test("composition shares provider, services, clock and logger; HTTP does not construct a runner", () => {
  probe(`
    const config = { port: 4000, clientOrigin: 'https://configured.example', runner: { enabled: false, intervalMs: 1500 } };
    const provider = () => { throw Error('Composition must remain DB-lazy'); };
    const instant = new Date('2026-10-28T12:00:00Z');
    const clock = () => instant;
    const logger = {};
    const services = {}, repositories = {}, routers = {};
    const deleteArea = async () => {};
    const detachAreaLinks = async () => {};
    let runnerCalls = 0, appOptions;
    const replacements = {
      '/application/delete-area.ts': { createDeleteArea(repository, detach) {
        assert.equal(repository, repositories.areas); assert.equal(detach, detachAreaLinks); return deleteArea;
      } },
      '/tasks/area-links.ts': { detachAreaLinks },
      '/app.ts': { createApp(options) { appOptions = options; return 'HTTP'; } },
      '/http/middleware/request-logger.ts': { createRequestLogger(value) { assert.equal(value, logger); return 'HTTP logger'; } },
      '/runner/routines.runner.ts': { createRoutineRunner(dependencies) {
        runnerCalls++;
        assert.equal(dependencies.repository, repositories.routines);
        assert.equal(dependencies.service, services.routines);
        assert.equal(dependencies.logger, logger);
        assert.equal(dependencies.clock(), instant.getTime());
        return 'runner';
      } },
    };
    for (const [name, singular, factory] of [['tasks', 'tasks', 'Tasks'], ['areas', 'areas', 'Areas'], ['routines', 'routines', 'Routines']]) {
      replacements['/' + singular + '.repository.ts'] = { ['create' + factory + 'Repository'](value) {
        assert.equal(value, provider); assert.equal(repositories[name], undefined);
        return repositories[name] = {};
      } };
      replacements['/' + singular + '.service.ts'] = { ['create' + factory + 'Service'](repository, now) {
        assert.equal(repository, repositories[name]);
        if (name !== 'areas') assert.equal(now, clock);
        return services[name] = {};
      } };
      replacements['/' + singular + '.routes.ts'] = { ['create' + factory + 'Router'](service, remove) {
        assert.equal(service, services[name]);
        if (name === 'areas') assert.equal(remove, deleteArea);
        return routers[name] = {};
      } };
    }
    Module._load = function(request, parent, main) {
      const filename = resolve(request, parent);
      for (const [suffix, value] of Object.entries(replacements)) if (filename.endsWith(suffix)) return value;
      return originalLoad.apply(this, arguments);
    };
    const composition = require('./src/application/compose.ts').composeApplication({ config, client: provider, now: clock, logger });
    assert.equal(runnerCalls, 0);
    assert.equal(composition.createHttpApp(), 'HTTP');
    assert.equal(runnerCalls, 0);
    assert.deepEqual(appOptions.routers, routers);
    assert.equal(appOptions.clientOrigin, config.clientOrigin);
    assert.equal(appOptions.httpLogger, 'HTTP logger');
    assert.equal(composition.createRunner(), 'runner');
    assert.equal(runnerCalls, 1);
  `);
});

for (const enabled of [true, false]) {
  test(`server wiring loads env first and preserves startup/shutdown (runner enabled=${enabled})`, () => {
    probe(`
      const events = [], handlers = {};
      let listening, closeDone, stopDone;
      const runner = {
        start(interval) { assert.equal(interval, 1500); events.push('start'); },
        stop() { events.push('stop'); return new Promise(resolve => { stopDone = resolve; }); },
      };
      const composition = {
        createHttpApp() { events.push('http'); return { listen(port, callback) {
          assert.equal(port, 4567); events.push('listen'); listening = callback;
          return { close(callback) { events.push('close'); closeDone = callback; } };
        } }; },
        createRunner() { events.push('runner'); return runner; },
      };
      process.once = function(signal, handler) { handlers[signal] = handler; return this; };
      Module._load = function(request, parent, main) {
        if (request === 'dotenv/config') {
          events.push('dotenv'); process.env.PORT = '4567';
          process.env.ROUTINE_AUTO_GENERATION_ENABLED = '${enabled}';
          process.env.ROUTINE_AUTO_GENERATION_INTERVAL_MS = '1500';
          return {};
        }
        const filename = resolve(request, parent);
        if (filename.endsWith('/application/compose.ts')) return { composeApplication({config}) {
          assert.equal(events[0], 'dotenv'); assert.equal(config.runner.enabled, ${enabled});
          events.push('compose'); return composition;
        } };
        if (filename.endsWith('/database/prisma.ts')) return { async disconnectPrisma() { events.push('disconnect'); } };
        return originalLoad.apply(this, arguments);
      };
      require('./src/server.ts');
      assert.deepEqual(events, ['dotenv', 'compose', 'http', 'runner', 'listen']);
      assert.deepEqual(Object.keys(handlers).sort(), ['SIGINT', 'SIGTERM']);
      listening();
      assert.equal(events.includes('start'), ${enabled});
      handlers.SIGTERM(); handlers.SIGINT();
      assert.deepEqual(events.slice(-2), ['close', 'stop']);
      stopDone(); await Promise.resolve(); await Promise.resolve();
      assert.equal(events.includes('disconnect'), false);
      closeDone(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      assert.equal(events.at(-1), 'disconnect');
      assert.equal(events.filter(event => event === 'close').length, 1);
    `);
  });
}

for (const outcome of ["success", "errors", "throw"]) {
  test(`CLI wiring uses runOnce with timer disabled and preserves cleanup/exit code (${outcome})`, () => {
    probe(`
      const events = [];
      const result = { errors: ${outcome === "errors" ? 1 : 0} };
      const outputs = [];
      console.log = value => outputs.push(value);
      console.error = value => outputs.push(value);
      Module._load = function(request, parent, main) {
        if (request === 'dotenv/config') {
          events.push('dotenv'); process.env.ROUTINE_AUTO_GENERATION_ENABLED = 'false';
          process.env.ROUTINE_AUTO_GENERATION_INTERVAL_MS = '1500'; return {};
        }
        const filename = resolve(request, parent);
        if (filename.endsWith('/application/compose.ts')) return { composeApplication({config}) {
          assert.equal(events[0], 'dotenv'); assert.equal(config.runner.enabled, false);
          events.push('compose'); return {
            createHttpApp() { throw Error('CLI must not build HTTP'); },
            createRunner() { events.push('runner'); return {
              start() { throw Error('CLI must not start periodic generation'); },
              async runOnce() { events.push('runOnce'); ${outcome === "throw" ? "throw Error('fake failure');" : "return result;"} },
              async stop() { events.push('stop'); },
            }; },
          };
        } };
        if (filename.endsWith('/database/prisma.ts')) return { async disconnectPrisma() { events.push('disconnect'); } };
        return originalLoad.apply(this, arguments);
      };
      require('./src/cli/generate-routines.ts');
      for (let i = 0; i < 12; i++) await Promise.resolve();
      assert.deepEqual(events, ['dotenv', 'compose', 'runner', 'runOnce', 'stop', 'disconnect']);
      assert.equal(process.exitCode ?? 0, ${outcome === "success" ? 0 : 1});
      ${outcome === "throw" ? "assert.match(outputs[0], /Routine generation command failed/);" : "assert.deepEqual(JSON.parse(outputs[0]), result);"}
      process.exitCode = 0;
    `);
  });
}
