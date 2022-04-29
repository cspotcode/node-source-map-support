// @ts-check
// Note: some tests rely on side-effects from prior tests.
// You may not get meaningful results running a subset of tests.

const Module = require('module');
const priorErrorPrepareStackTrace = Error.prepareStackTrace;
const priorProcessEmit = process.emit;
const priorResolveFilename = Module._resolveFilename;
const underTest = require('./source-map-support');
var SourceMapGenerator = require('source-map').SourceMapGenerator;
var child_process = require('child_process');
var assert = require('assert');
var fs = require('fs');
var util = require('util');
var bufferFrom = Buffer.from;
const semver = require('semver');

// Helper to create regular expressions from string templates, to use interpolation
function re(...args) {
  return new RegExp(String.raw(...args));
}

//#region module format differences
function namedExportDeclaration() {
  // same length so that offsets are the same either way
  return extension === 'mjs'
    ? 'export const test'
    : 'exports.test     ';
}
/**
 * How stack frame will describe invocations of the `test` function, when it is imported and invoked by a different file.
 * This varies across CJS / ESM and node versions.
 * Example: `    at Module.exports.test (`...
 */
function stackFrameAtTest(sourceMapSupportInstalled = true) {
  if(semver.gte(process.versions.node, '18.0.0')) {
    return extension === 'mjs' ? 'Module\\.test' : sourceMapSupportInstalled ? 'Module\\.exports\\.test' : 'exports\\.test';
  } else {
    return extension === 'mjs' ? 'Module\\.test' : 'Module\\.exports\\.test';
  }
}
/**
 * Describes the first stack frame for `console.trace` which is slightly different in ESM and CJS
 */
function stackFrameAtTrace(fileRe) {
  return extension === 'mjs' ? `${fileRe}` : `Object\\.<anonymous> \\(${fileRe}\\)`;
}
/**
 * Tests were initially written as CJS with require() calls.
 * We can support require() calls in MJS tests, too, as long as we create a require() function.
 * Keep both prefixes the same length so that offsets are the same
 */
function srcPrefix() {
  return extension === 'mjs'
    ? `import {createRequire} from 'module';const require = createRequire(import.meta.url);`
    : `                                                                                    `;
}
//#endregion

// Assign each test a unique ID, to be used in filenames.
// Eliminates need for cache invalidation, because node ESM has no way to
// invalidate cache.
let id = 0;
let extension;
beforeEach(function() {
  id++;
  extension = 'js';
});

// Consolidate cleanup into a hook so that failed assertions do not leave files
// on disk.
afterEach(function() {
  for(const name of [`generated`, `generated2`, `original`, `original2`]) {
    for(const suffix of [``, `-separate`, `-inline`]) {
      for(const ext of [`js`, `cjs`, `mjs`]) {
        for(const ext2 of [``, `.map`, `.map.extra`]) {
          const file = `.${name}-${id}${suffix}.${ext}${ext2}`;
          fs.existsSync(file) && fs.unlinkSync(file);
        }
      }
    }
  }
});

function compareLines(actual, expected) {
  assert(actual.length >= expected.length, 'got ' + actual.length + ' lines but expected at least ' + expected.length + ' lines\n' + util.inspect({actual, expected}));
  for (var i = 0; i < expected.length; i++) {
    // Some tests are regular expressions because the output format changed slightly between node v0.9.2 and v0.9.3
    if (expected[i] instanceof RegExp) {
      assert(expected[i].test(actual[i]), JSON.stringify(actual[i]) + ' does not match ' + expected[i] + '\n' + JSON.stringify({actual, expected: expected.map(v => typeof v === 'string' ? v : v.toString())}, null, 2));
    } else {
      assert.equal(actual[i], expected[i]);
    }
  }
}

function sourceMapCreators() {
  return {
    createEmptySourceMap,
    createSourceMapWithGap,
    createSingleLineSourceMap,
    createSecondLineSourceMap,
    createMultiLineSourceMap,
    createMultiLineSourceMapWithSourcesContent
  };
  function createEmptySourceMap() {
    return new SourceMapGenerator({
      file: `.generated-${id}.${extension}`,
      sourceRoot: '.'
    });
  }

  function createSourceMapWithGap() {
    var sourceMap = createEmptySourceMap();
    sourceMap.addMapping({
      generated: { line: 100, column: 0 },
      original: { line: 100, column: 0 },
      source: `.original-${id}.js`
    });
    return sourceMap;
  }

  function createSingleLineSourceMap() {
    var sourceMap = createEmptySourceMap();
    sourceMap.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: `.original-${id}.js`
    });
    return sourceMap;
  }

  function createSecondLineSourceMap() {
    var sourceMap = createEmptySourceMap();
    sourceMap.addMapping({
      generated: { line: 2, column: 0 },
      original: { line: 1, column: 0 },
      source: `.original-${id}.js`
    });
    return sourceMap;
  }

  function createMultiLineSourceMap() {
    var sourceMap = createEmptySourceMap();
    for (var i = 1; i <= 100; i++) {
      sourceMap.addMapping({
        generated: { line: i, column: 0 },
        original: { line: 1000 + i, column: 99 + i },
        source: 'line' + i + '.js'
      });
    }
    return sourceMap;
  }

  function createMultiLineSourceMapWithSourcesContent() {
    var sourceMap = createEmptySourceMap();
    var original = new Array(1001).join('\n');
    for (var i = 1; i <= 100; i++) {
      sourceMap.addMapping({
        generated: { line: i, column: 0 },
        original: { line: 1000 + i, column: 4 },
        source: `original-${id}.js`
      });
      original += '    line ' + i + '\n';
    }
    sourceMap.setSourceContent(`original-${id}.js`, original);
    return sourceMap;
  }
}

function rewriteExpectation(expected, generatedFilenameIn, generatedFilenameOut) {
  return expected.map(v => {
    if(v instanceof RegExp) return new RegExp(v.source.replace(generatedFilenameIn, generatedFilenameOut));
    return v.replace(generatedFilenameIn, generatedFilenameOut);
  });
}
async function compareStackTrace(sourceMap, source, expected) {
  const header = srcPrefix();
  // Check once with a separate source map
  // fs.writeFileSync(`.generated-${id}-separate.${extension}.map`, JSON.stringify({...JSON.parse(sourceMap.toString()), file: `.generated-${id}-separate.${extension}`}));
  fs.writeFileSync(`.generated-${id}-separate.${extension}.map`, sourceMap.toString());
  fs.writeFileSync(`.generated-${id}-separate.${extension}`, `${header}${namedExportDeclaration()} = function() {` +
    source.join('\n') + `};//@ sourceMappingURL=.generated-${id}-separate.${extension}.map`);
  try {
    (await import(`./.generated-${id}-separate.${extension}`)).test();
  } catch (e) {
    compareLines(e.stack.split(/\r\n|\n/), rewriteExpectation(expected, `.generated-${id}`, `.generated-${id}-separate`));
  }

  // Check again with an inline source map (in a data URL)
  fs.writeFileSync(`.generated-${id}-inline.${extension}`, `${header}${namedExportDeclaration()} = function() {` +
    source.join('\n') + '};//@ sourceMappingURL=data:application/json;base64,' +
    bufferFrom(sourceMap.toString()).toString('base64'));
  try {
    (await import (`./.generated-${id}-inline.${extension}`)).test();
  } catch (e) {
    compareLines(e.stack.split(/\r\n|\n/), rewriteExpectation(expected, `.generated-${id}`, `.generated-${id}-inline`));
  }
}

function compareStdout(done, sourceMap, source, expected) {
  let header = srcPrefix();
  fs.writeFileSync(`.original-${id}.js`, 'this is the original code');
  fs.writeFileSync(`.generated-${id}.${extension}.map`, sourceMap.toString());
  fs.writeFileSync(`.generated-${id}.${extension}`, header + source.join('\n') +
    `//@ sourceMappingURL=.generated-${id}.${extension}.map`);
  child_process.exec(`node ./.generated-${id}.${extension}`, function(error, stdout, stderr) {
    try {
      compareLines(
        (stdout + stderr)
          .trim()
          .split(/\r\n|\n/)
          // Empty lines are not relevant.
          // Running in a debugger causes additional output.
          .filter(function (line) { return line !== '' && line !== 'Debugger attached.' }),
        expected
      );
    } catch (e) {
      return done(e);
    }
    done();
  });
}

function installSms() {
  underTest.install({
    emptyCacheBetweenOperations: true // Needed to be able to test for failure
  });
}

function getTestMacros(sourceMapConstructors) {
  return {normalThrow, normalThrowWithoutSourceMapSupportInstalled};
async function normalThrow() {
  await compareStackTrace(sourceMapConstructors.createMultiLineSourceMap(), [
    'throw new Error("test");'
  ], [
    'Error: test',
    re`^    at ${stackFrameAtTest()} \((?:.*[/\\])?line1\.js:1001:101\)$`
  ]);
}
async function normalThrowWithoutSourceMapSupportInstalled() {
  await compareStackTrace(sourceMapConstructors.createMultiLineSourceMap(), [
    'throw new Error("test");'
  ], [
    'Error: test',
    re`^    at ${stackFrameAtTest(false)} \((?:.*[/\\])?\.generated-${id}\.${extension}:1:123\)$`
  ]);
}
}

function describePerModuleType(fn, ...args) {
  for(const ext of ['cjs', 'mjs']) {
    describe(`${ext} >`, () => {
      beforeEach(function() {
        extension = ext;
      });
      fn(...args);
    });
  }
}

describe('Without source-map-support installed', function() {
  describePerModuleType(() => {
    const sourceMapConstructors = sourceMapCreators();
    const macros = getTestMacros(sourceMapConstructors);
    const {normalThrowWithoutSourceMapSupportInstalled} = macros;

    it('normal throw without source-map-support installed', async function () {
      await normalThrowWithoutSourceMapSupportInstalled();
    });
  });
});

function identity(v) {return v}
function addRelativePrefixToSourceMapPaths(sourceMap) {
  addPrefixToSourceMapPaths(sourceMap, './');
  return sourceMap;
}
function addAbsolutePrefixToSourceMapPaths(sourceMap) {
  addPrefixToSourceMapPaths(sourceMap, '/root/project/');
  return sourceMap;
}
function addFileUrlAbsolutePrefixToSourceMapPaths(sourceMap) {
  addPrefixToSourceMapPaths(sourceMap, 'file:///root/project/');
  return sourceMap;
}
function addPrefixToSourceMapPaths(sourceMap, prefix) {
  function addPrefix(path) {return `${prefix}${path}`}
  sourceMap.file = addPrefix(sourceMap.file);
  if(sourceMap.sources) sourceMap.sources = sourceMap.sources.map(addPrefix);
  return sourceMap;
}

describe('sourcemap style: relative paths sans ./ prefix, e.g. "original-1.js" >', () => {
  describePerModuleType(tests, identity);
});
describe('sourcemap style: relative paths with ./ prefix, e.g. "./original-1.js" >', () => {
  describePerModuleType(tests, addRelativePrefixToSourceMapPaths);
});
describe('sourcemap style: absolute paths and sourceRoot removed, e.g. "/abs/path/original-1.js" >', () => {
  describePerModuleType(tests, addAbsolutePrefixToSourceMapPaths);
});
describe('sourcemap style: file urls with absolute paths and sourceRoot removed, e.g. "file:///abs/path/original-1.js" >', () => {
  describePerModuleType(tests, addFileUrlAbsolutePrefixToSourceMapPaths);
});

function tests(sourceMapPostprocessor) {
  // let createEmptySourceMap, createMultiLineSourceMap, createMultiLineSourceMapWithSourcesContent, createSecondLineSourceMap, createSingleLineSourceMap, createSourceMapWithGap})
  const sourceMapConstructors = sourceMapCreators();
  for(const [key, value] of Object.entries(sourceMapConstructors)) {
    sourceMapConstructors[key] = (...args) => sourceMapPostprocessor(value(...args));
  }
  const {createEmptySourceMap, createMultiLineSourceMap, createMultiLineSourceMapWithSourcesContent, createSecondLineSourceMap, createSingleLineSourceMap, createSourceMapWithGap} = sourceMapConstructors;
  const {normalThrow} = getTestMacros(sourceMapConstructors);

it('normal throw', async function() {
  installSms();
  await normalThrow();
});

/* The following test duplicates some of the code in
 * `normal throw` but triggers file read failure.
 */
it('fs.readFileSync failure', async function() {
  await compareStackTrace(createMultiLineSourceMap(), [
    'var fs = require("fs");',
    'var rfs = fs.readFileSync;',
    'fs.readFileSync = function() {',
    '  throw new Error("no rfs for you");',
    '};',
    'try {',
    '  throw new Error("test");',
    '} finally {',
    '  fs.readFileSync = rfs;',
    '}'
  ], [
    'Error: test',
    re`^    at ${stackFrameAtTest()} \((?:.*[/\\])?line7\.js:1007:107\)$`
  ]);
});


it('throw inside function', async function() {
  await compareStackTrace(createMultiLineSourceMap(), [
    'function foo() {',
    '  throw new Error("test");',
    '}',
    'foo();'
  ], [
    'Error: test',
    /^    at foo \((?:.*[/\\])?line2\.js:1002:102\)$/,
    re`^    at ${stackFrameAtTest()} \((?:.*[/\\])?line4\.js:1004:104\)$`
  ]);
});

it('throw inside function inside function', async function() {
  await compareStackTrace(createMultiLineSourceMap(), [
    'function foo() {',
    '  function bar() {',
    '    throw new Error("test");',
    '  }',
    '  bar();',
    '}',
    'foo();'
  ], [
    'Error: test',
    /^    at bar \((?:.*[/\\])?line3\.js:1003:103\)$/,
    /^    at foo \((?:.*[/\\])?line5\.js:1005:105\)$/,
    re`^    at ${stackFrameAtTest()} \((?:.*[/\\])?line7\.js:1007:107\)$`
  ]);
});

it('eval', async function() {
  await compareStackTrace(createMultiLineSourceMap(), [
    'eval("throw new Error(\'test\')");'
  ], [
    'Error: test',

    // TODO
    /^    at eval \(eval at (<anonymous>|exports\.test|test) \((?:.*[/\\])?line1\.js:1001:101\)/,

    re`^    at ${stackFrameAtTest()} \((?:.*[/\\])?line1\.js:1001:101\)$`
  ]);
});

it('eval inside eval', async function() {
  await compareStackTrace(createMultiLineSourceMap(), [
    'eval("eval(\'throw new Error(\\"test\\")\')");'
  ], [
    'Error: test',
    /^    at eval \(eval at (<anonymous>|exports\.test|test) \(eval at (<anonymous>|exports\.test|test) \((?:.*[/\\])?line1\.js:1001:101\)/,
    /^    at eval \(eval at (<anonymous>|exports\.test|test) \((?:.*[/\\])?line1\.js:1001:101\)/,
    re`^    at ${stackFrameAtTest()} \((?:.*[/\\])?line1\.js:1001:101\)$`
  ]);
});

it('eval inside function', async function() {
  await compareStackTrace(createMultiLineSourceMap(), [
    'function foo() {',
    '  eval("throw new Error(\'test\')");',
    '}',
    'foo();'
  ], [
    'Error: test',
    /^    at eval \(eval at foo \((?:.*[/\\])?line2\.js:1002:102\)/,
    /^    at foo \((?:.*[/\\])?line2\.js:1002:102\)/,
    re`^    at ${stackFrameAtTest()} \((?:.*[/\\])?line4\.js:1004:104\)$`
  ]);
});

it('eval with sourceURL', async function() {
  await compareStackTrace(createMultiLineSourceMap(), [
    'eval("throw new Error(\'test\')//@ sourceURL=sourceURL.js");'
  ], [
    'Error: test',
    /^    at eval \(sourceURL\.js:1:7\)$/,
    re`^    at ${stackFrameAtTest()} \((?:.*[/\\])?line1\.js:1001:101\)$`
  ]);
});

it('eval with sourceURL inside eval', async function() {
  await compareStackTrace(createMultiLineSourceMap(), [
    'eval("eval(\'throw new Error(\\"test\\")//@ sourceURL=sourceURL.js\')");'
  ], [
    'Error: test',
    /^    at eval \(sourceURL\.js:1:7\)$/,
    /^    at eval \(eval at (<anonymous>|exports.test|test) \((?:.*[/\\])?line1\.js:1001:101\)/,
    re`^    at ${stackFrameAtTest()} \((?:.*[/\\])?line1\.js:1001:101\)$`
  ]);
});

it('native function', async function() {
  await compareStackTrace(createSingleLineSourceMap(), [
    '[1].map(function(x) { throw new Error(x); });'
  ], [
    'Error: 1',
    re`[/\\].original-${id}.js`,
    /at Array\.map \((native|<anonymous>)\)/
  ]);
});

it('function constructor', async function() {
  await compareStackTrace(createMultiLineSourceMap(), [
    'throw new Function(")");'
  ], [
    /SyntaxError: Unexpected token '?\)'?/,
  ]);
});

it('throw with empty source map', async function() {
  await compareStackTrace(createEmptySourceMap(), [
    'throw new Error("test");'
  ], [
    'Error: test',
    re`^    at ${stackFrameAtTest()} \((?:.*[/\\])?\.generated-${id}.${extension}:1:123\)$`
  ]);
});

it('throw in Timeout with empty source map', function(done) {
  compareStdout(done, createEmptySourceMap(), [
    'require("./source-map-support").install();',
    'setTimeout(function () {',
    '    throw new Error("this is the error")',
    '})'
  ], [
    re`[/\\].generated-${id}.${extension}:3$`,
    '    throw new Error("this is the error")',
    /^          \^$/,
    'Error: this is the error',
    re`^    at ((null)|(Timeout))\._onTimeout \((?:.*[/\\])?.generated-${id}\.${extension}:3:11\)$`
  ]);
});

it('throw with source map with gap', async function() {
  await compareStackTrace(createSourceMapWithGap(), [
    'throw new Error("test");'
  ], [
    'Error: test',
    re`^    at ${stackFrameAtTest()} \((?:.*[/\\])?\.generated-${id}\.${extension}:1:123\)$`
  ]);
});

it('sourcesContent with data URL', async function() {
  await compareStackTrace(createMultiLineSourceMapWithSourcesContent(), [
    'throw new Error("test");'
  ], [
    'Error: test',
    re`^    at ${stackFrameAtTest()} \((?:.*[/\\])?original-${id}\.js:1001:5\)$`
  ]);
});

it('finds the last sourceMappingURL', async function() {
  await compareStackTrace(createMultiLineSourceMapWithSourcesContent(), [
    '//# sourceMappingURL=missing.map.js',  // NB: compareStackTrace adds another source mapping.
    'throw new Error("test");'
  ], [
    'Error: test',
    re`^    at ${stackFrameAtTest()} \((?:.*[/\\])?original-${id}\.js:1002:5\)$`
  ]);
});

it('maps original name from source', async function() {
  var sourceMap = createEmptySourceMap();
  sourceMap.addMapping({
    generated: { line: 2, column: 8 },
    original: { line: 1000, column: 10 },
    source: `.original-${id}.js`,
  });
  sourceMap.addMapping({
    generated: { line: 4, column: 0 },
    original: { line: 1002, column: 1 },
    source: `.original-${id}.js`,
    name: "myOriginalName"
  });
  await compareStackTrace(sourceMap, [
    'function foo() {',
    '  throw new Error("test");',
    '}',
    'foo();'
  ], [
    'Error: test',
    re`^    at myOriginalName \((?:.*[/\\])?\.original-${id}.js:1000:11\)$`,
    re`^    at ${stackFrameAtTest()} \((?:.*[/\\])?\.original-${id}.js:1002:2\)$`
  ]);
});

it('default options', function(done) {
  compareStdout(done, createSecondLineSourceMap(), [
    '',
    'function foo() { throw new Error("this is the error"); }',
    'require("./source-map-support").install();',
    'process.nextTick(foo);',
    'process.nextTick(function() { process.exit(1); });'
  ], [
    re`[/\\].original-${id}\.js:1$`,
    'this is the original code',
    '^',
    'Error: this is the error',
    re`^    at foo \((?:.*[/\\])?\.original-${id}\.js:1:1\)$`
  ]);
});

it('handleUncaughtExceptions is true', function(done) {
  compareStdout(done, createSecondLineSourceMap(), [
    '',
    'function foo() { throw new Error("this is the error"); }',
    'require("./source-map-support").install({ handleUncaughtExceptions: true });',
    'process.nextTick(foo);'
  ], [
    re`[/\\].original-${id}\.js:1$`,
    'this is the original code',
    '^',
    'Error: this is the error',
    re`^    at foo \((?:.*[/\\])?\.original-${id}\.js:1:1\)$`
  ]);
});

it('handleUncaughtExceptions is false', function(done) {
  compareStdout(done, createSecondLineSourceMap(), [
    '',
    'function foo() { throw new Error("this is the error"); }',
    'require("./source-map-support").install({ handleUncaughtExceptions: false });',
    'process.nextTick(foo);'
  ], [
    re`[/\\].generated-${id}.${extension}:2$`,
    'function foo() { throw new Error("this is the error"); }',

    '                 ^',

    'Error: this is the error',
    re`^    at foo \((?:.*[/\\])?.original-${id}\.js:1:1\)$`
  ]);
});

it('default options with empty source map', function(done) {
  compareStdout(done, createEmptySourceMap(), [
    '',
    'function foo() { throw new Error("this is the error"); }',
    'require("./source-map-support").install();',
    'process.nextTick(foo);'
  ], [
    re`[/\\].generated-${id}.${extension}:2$`,
    'function foo() { throw new Error("this is the error"); }',
    '                       ^',
    'Error: this is the error',
    re`^    at foo \((?:.*[/\\])?.generated-${id}.${extension}:2:24\)$`
  ]);
});

it('default options with source map with gap', function(done) {
  compareStdout(done, createSourceMapWithGap(), [
    '',
    'function foo() { throw new Error("this is the error"); }',
    'require("./source-map-support").install();',
    'process.nextTick(foo);'
  ], [
    re`[/\\].generated-${id}.${extension}:2$`,
    'function foo() { throw new Error("this is the error"); }',
    '                       ^',
    'Error: this is the error',
    re`^    at foo \((?:.*[/\\])?.generated-${id}.${extension}:2:24\)$`
  ]);
});

it('specifically requested error source', function(done) {
  compareStdout(done, createSecondLineSourceMap(), [
    '',
    'function foo() { throw new Error("this is the error"); }',
    'var sms = require("./source-map-support");',
    'sms.install({ handleUncaughtExceptions: false });',
    'process.on("uncaughtException", function (e) { console.log("SRC:" + sms.getErrorSource(e)); });',
    'process.nextTick(foo);'
  ], [
    re`^SRC:.*[/\\]\.original-${id}\.js:1$`,
    'this is the original code',
    '^'
  ]);
});

it('sourcesContent', function(done) {
  compareStdout(done, createMultiLineSourceMapWithSourcesContent(), [
    '',
    'function foo() { throw new Error("this is the error"); }',
    'require("./source-map-support").install();',
    'process.nextTick(foo);',
    'process.nextTick(function() { process.exit(1); });'
  ], [
    re`[/\\]original-${id}\.js:1002$`,
    '    line 2',
    '    ^',
    'Error: this is the error',
    re`^    at foo \((?:.*[/\\])?original-${id}\.js:1002:5\)$`
  ]);
});

it('missing source maps should also be cached', function(done) {
  compareStdout(done, createSingleLineSourceMap(), [
    '',
    'var count = 0;',
    'function foo() {',
    '  console.log(new Error("this is the error").stack.split("\\n").slice(0, 2).join("\\n"));',
    '}',
    'require("./source-map-support").install({',
    '  overrideRetrieveSourceMap: true,',
    '  retrieveSourceMap: function(name) {',
    '    if (/\\.generated-\\d+\\.(js|cjs|mjs)$/.test(name)) count++;',
    '    return null;',
    '  }',
    '});',
    'process.nextTick(foo);',
    'process.nextTick(foo);',
    'process.nextTick(function() { console.log(count); });',
  ], [
    'Error: this is the error',
    re`^    at foo \((?:.*[/\\])?.generated-${id}.${extension}:4:15\)$`,
    'Error: this is the error',
    re`^    at foo \((?:.*[/\\])?.generated-${id}.${extension}:4:15\)$`,
    '1', // The retrieval should only be attempted once
  ]);
});

it('should consult all retrieve source map providers', function(done) {
  compareStdout(done, createSingleLineSourceMap(), [
    '',
    'var count = 0;',
    'function foo() {',
    '  console.log(new Error("this is the error").stack.split("\\n").slice(0, 2).join("\\n"));',
    '}',
    'require("./source-map-support").install({',
    '  retrieveSourceMap: function(name) {',
    `    if (/\\.generated-${id}\\.${extension}$/.test(name)) count++;`,
    '    return undefined;',
    '  }',
    '});',
    'require("./source-map-support").install({',
    '  retrieveSourceMap: function(name) {',
    `    if (/\\.generated-${id}\\.${extension}$/.test(name)) {`,
    '      count++;',
    '      return ' + JSON.stringify({url: `.original-${id}.js`, map: createMultiLineSourceMapWithSourcesContent().toJSON()}) + ';',
    '    }',
    '  }',
    '});',
    'process.nextTick(foo);',
    'process.nextTick(foo);',
    'process.nextTick(function() { console.log(count); });',
  ], [
    'Error: this is the error',
    re`^    at foo \((?:.*[/\\])?original-${id}\.js:1004:5\)$`,
    'Error: this is the error',
    re`^    at foo \((?:.*[/\\])?original-${id}\.js:1004:5\)$`,
    '1', // The retrieval should only be attempted once
  ]);
});

it('should allow for runtime inline source maps', function(done) {
  var sourceMap = createMultiLineSourceMapWithSourcesContent();

  fs.writeFileSync('.generated.jss', 'foo');

  compareStdout(function(err) {
    fs.unlinkSync('.generated.jss');
    done(err);
  }, createSingleLineSourceMap(), [
    'require("./source-map-support").install({',
    '  hookRequire: true',
    '});',
    'require.extensions[".jss"] = function(module, filename) {',
    '  module._compile(',
        JSON.stringify([
          '',
          'var count = 0;',
          'function foo() {',
          '  console.log(new Error("this is the error").stack.split("\\n").slice(0, 2).join("\\n"));',
          '}',
          'process.nextTick(foo);',
          'process.nextTick(foo);',
          'process.nextTick(function() { console.log(count); });',
          '//@ sourceMappingURL=data:application/json;charset=utf8;base64,' + bufferFrom(sourceMap.toString()).toString('base64')
        ].join('\n')),
        ', filename);',
    '};',
    'require("./.generated.jss");',
  ], [
    'Error: this is the error',
    re`^    at foo \(.*[/\\]original-${id}\.js:1004:5\)$`,
    'Error: this is the error',
    re`^    at foo \(.*[/\\]original-${id}\.js:1004:5\)$`,
    '0', // The retrieval should only be attempted once
  ]);
});
// }

// TODO should this suite also be inside the matrix?
// describe('Other', function() {
  // Wrapped in a suite to preserve test execution order
  // const {createEmptySourceMap, createSingleLineSourceMap, createMultiLineSourceMap} = sourceMapCreators();
  // const extension = 'cjs';

/* The following test duplicates some of the code in
 * `compareStackTrace` but appends a charset to the
 * source mapping url.
 */
it('finds source maps with charset specified', async function() {
  var sourceMap = createMultiLineSourceMap()
  var source = [ 'throw new Error("test");' ];
  var expected = [
    'Error: test',
    re`^    at ${stackFrameAtTest()} \((?:.*[/\\])?line1\.js:1001:101\)$`
  ];

  fs.writeFileSync(`.generated-${id}.${extension}`, `${namedExportDeclaration()} = function() {` +
    source.join('\n') + '};//@ sourceMappingURL=data:application/json;charset=utf8;base64,' +
    bufferFrom(sourceMap.toString()).toString('base64'));
  try {
    (await import(`./.generated-${id}.${extension}`)).test();
  } catch (e) {
    compareLines(e.stack.split(/\r\n|\n/), expected);
  }
});

/* The following test duplicates some of the code in
 * `compareStackTrace` but appends some code and a
 * comment to the source mapping url.
 */
it('allows code/comments after sourceMappingURL', async function() {
  var sourceMap = createMultiLineSourceMap()
  var source = [ 'throw new Error("test");' ];
  var expected = [
    'Error: test',
    re`^    at ${stackFrameAtTest()} \((?:.*[/\\])?line1\.js:1001:101\)$`
  ];

  fs.writeFileSync(`.generated-${id}.${extension}`, `${namedExportDeclaration()} = function() {` +
    source.join('\n') + '};//# sourceMappingURL=data:application/json;base64,' +
    bufferFrom(sourceMap.toString()).toString('base64') +
    '\n// Some comment below the sourceMappingURL\nvar foo = 0;');
  try {
    (await import(`./.generated-${id}.${extension}`)).test();
  } catch (e) {
    compareLines(e.stack.split(/\r\n|\n/), expected);
  }
});

it('handleUncaughtExceptions is true with existing listener', function(done) {
  var source = [
    'process.on("uncaughtException", function() { /* Silent */ });',
    'function foo() { throw new Error("this is the error"); }',
    'require("./source-map-support").install();',
    'process.nextTick(foo);',
    `//@ sourceMappingURL=.generated-${id}.${extension}.map`
  ];

  fs.writeFileSync(`.original-${id}.js`, 'this is the original code');
  fs.writeFileSync(`.generated-${id}.${extension}.map`, createSingleLineSourceMap().toString());
  fs.writeFileSync(`.generated-${id}.${extension}`, source.join('\n'));

  child_process.exec(`node ./.generated-${id}.${extension}`, function(error, stdout, stderr) {
    assert.equal((stdout + stderr).trim(), '');
    done();
  });
});

it('normal console.trace', function(done) {
  compareStdout(done, createMultiLineSourceMap(), [
    'require("./source-map-support").install();',
    'console.trace("test");'
  ], [
    'Trace: test',
    re`^    at ${stackFrameAtTrace(String.raw`(?:.*[/\\])?line2\.js:1002:102`)}$`
  ]);
});

it('supports multiple instances', function(done) {
  var sourceMap = createEmptySourceMap();
  sourceMap.addMapping({
    generated: { line: 1, column: 0 },
    original: { line: 1, column: 0 },
    source: `.original2-${id}.js`
  });
  fs.writeFileSync(`.generated2-${id}.${extension}.map.extra`, sourceMap.toString());
  fs.writeFileSync(`.generated2-${id}.${extension}`, [
    `${namedExportDeclaration()} = function test() { throw new Error("this is the error"); }`,
    `//@ sourceMappingURL=.generated2-${id}.${extension}.map`
  ].join('\n'));
  fs.writeFileSync(`.original2-${id}.js`, 'this is some other original code');
  compareStdout(done, createEmptySourceMap(), [
    '(async function() {',
    '  require("./source-map-support").install({',
    '    retrieveFile: function(path) {',
    '      var fs = require("fs");',
    '      var url = require("url");',
    '      try { path = url.fileURLToPath(path) } catch {}',
    '      if (fs.existsSync(path + ".extra")) {',
    '        return fs.readFileSync(path + ".extra", "utf8");',
    '      }',
    '    }',
    '  });',
    `  var {test} = await import("./.generated2-${id}.${extension}");`,
    '  delete require.cache[require.resolve("./source-map-support")];',
    '  require("./source-map-support").install();',
    '  process.nextTick(test);',
    '  process.nextTick(function() { process.exit(1); });',
    '})();'
  ], [
    re`[/\\].original2-${id}\.js:1$`,
    'this is some other original code',
    '^',
    'Error: this is the error',
    re`^    at test \((?:.*[/\\])?.original2-${id}\.js:1:1\)$`
  ]);
});
// });
}

describe('redirects require() of "source-map-support" to this module', function() {
  it('redirects', async function() {
    assert.strictEqual(require.resolve('source-map-support'), require.resolve('.'));
    assert.strictEqual(require.resolve('source-map-support/register'), require.resolve('./register'));
    assert.strictEqual(require('source-map-support'), require('.'));
  });

  it('emits notifications', async function() {
    let onConflictingLibraryRedirectCalls = [];
    let onConflictingLibraryRedirectCalls2 = [];
    underTest.install({
      onConflictingLibraryRedirect(request, parent, isMain, redirectedRequest) {
        onConflictingLibraryRedirectCalls.push([...arguments]);
      }
    });
    underTest.install({
      onConflictingLibraryRedirect(request, parent, isMain, redirectedRequest) {
        onConflictingLibraryRedirectCalls2.push([...arguments]);
      }
    });
    require.resolve('source-map-support');
    assert.strictEqual(onConflictingLibraryRedirectCalls.length, 1);
    assert.strictEqual(onConflictingLibraryRedirectCalls2.length, 1);
    for(const args of [onConflictingLibraryRedirectCalls[0], onConflictingLibraryRedirectCalls2[0]]) {
      const [request, parent, isMain, options, redirectedRequest] = args;
      assert.strictEqual(request, 'source-map-support');
      assert.strictEqual(parent, module);
      assert.strictEqual(isMain, false);
      assert.strictEqual(options, undefined);
      assert.strictEqual(redirectedRequest, require.resolve('.'));
    }
  });
});

describe('uninstall', function() {
  const sourceMapConstructors = sourceMapCreators();
  const {normalThrow, normalThrowWithoutSourceMapSupportInstalled} = getTestMacros(sourceMapConstructors);

  this.beforeEach(function() {
    underTest.uninstall();
    process.emit = priorProcessEmit;
    Error.prepareStackTrace = priorErrorPrepareStackTrace;
    Module._resolveFilename = priorResolveFilename;
  });

  it('uninstall removes hooks and source-mapping behavior', async function() {
    assert.strictEqual(Error.prepareStackTrace, priorErrorPrepareStackTrace);
    assert.strictEqual(process.emit, priorProcessEmit);
    assert.strictEqual(Module._resolveFilename, priorResolveFilename);
    await normalThrowWithoutSourceMapSupportInstalled();
  });

  it('install re-adds hooks', async function() {
    installSms();
    await normalThrow();
  });

  it('uninstall removes prepareStackTrace even in presence of third-party hooks if none were installed before us', async function() {
    installSms();
    const wrappedPrepareStackTrace = Error.prepareStackTrace;
    let pstInvocations = 0;
    function thirdPartyPrepareStackTraceHook() {
      pstInvocations++;
      return wrappedPrepareStackTrace.apply(this, arguments);
    }
    Error.prepareStackTrace = thirdPartyPrepareStackTraceHook;
    underTest.uninstall();
    assert.strictEqual(Error.prepareStackTrace, undefined);
    assert(pstInvocations === 0);
  });

  it('uninstall preserves third-party prepareStackTrace hooks if one was installed before us', async function() {
    let beforeInvocations = 0;
    function thirdPartyPrepareStackTraceHookInstalledBefore() {
      beforeInvocations++;
      return 'foo';
    }
    Error.prepareStackTrace = thirdPartyPrepareStackTraceHookInstalledBefore;
    installSms();
    const wrappedPrepareStackTrace = Error.prepareStackTrace;
    let afterInvocations = 0;
    function thirdPartyPrepareStackTraceHookInstalledAfter() {
      afterInvocations++;
      return wrappedPrepareStackTrace.apply(this, arguments);
    }
    Error.prepareStackTrace = thirdPartyPrepareStackTraceHookInstalledAfter;
    underTest.uninstall();
    assert.strictEqual(Error.prepareStackTrace, thirdPartyPrepareStackTraceHookInstalledAfter);
    assert.strictEqual(new Error().stack, 'foo');
    assert.strictEqual(beforeInvocations, 1);
    assert.strictEqual(afterInvocations, 1);
  });

  it('uninstall preserves third-party process.emit hooks installed after us', async function() {
    installSms();
    const wrappedProcessEmit = process.emit;
    let peInvocations = 0;
    function thirdPartyProcessEmit() {
      peInvocations++;
      return wrappedProcessEmit.apply(this, arguments);
    }
    process.emit = thirdPartyProcessEmit;
    underTest.uninstall();
    assert.strictEqual(process.emit, thirdPartyProcessEmit);
    await normalThrowWithoutSourceMapSupportInstalled();
    process.emit('foo');
    assert(peInvocations >= 1);
  });

  it('uninstall preserves third-party module._resolveFilename hooks installed after us', async function() {
    installSms();
    const wrappedResolveFilename = Module._resolveFilename;
    let peInvocations = 0;
    function thirdPartyModuleResolveFilename() {
      peInvocations++;
      return wrappedResolveFilename.apply(this, arguments);
    }
    Module._resolveFilename = thirdPartyModuleResolveFilename;
    underTest.uninstall();
    assert.strictEqual(Module._resolveFilename, thirdPartyModuleResolveFilename);
    await normalThrowWithoutSourceMapSupportInstalled();
    Module._resolveFilename('repl');
    assert(peInvocations >= 1);
  });
});
