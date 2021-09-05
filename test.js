require('./source-map-support').install({
  emptyCacheBetweenOperations: true // Needed to be able to test for failure
});

var SourceMapGenerator = require('source-map').SourceMapGenerator;
var child_process = require('child_process');
var assert = require('assert');
var fs = require('fs');
var util = require('util');
var bufferFrom = Buffer.from;

function compareLines(actual, expected) {
  assert(actual.length >= expected.length, 'got ' + actual.length + ' lines but expected at least ' + expected.length + ' lines\n' + util.inspect({actual, expected}));
  for (var i = 0; i < expected.length; i++) {
    // Some tests are regular expressions because the output format changed slightly between node v0.9.2 and v0.9.3
    if (expected[i] instanceof RegExp) {
      assert(expected[i].test(actual[i]), JSON.stringify(actual[i]) + ' does not match ' + expected[i]);
    } else {
      assert.equal(actual[i], expected[i]);
    }
  }
}

function createEmptySourceMap() {
  return new SourceMapGenerator({
    file: '.generated.js',
    sourceRoot: '.'
  });
}

function createSourceMapWithGap() {
  var sourceMap = createEmptySourceMap();
  sourceMap.addMapping({
    generated: { line: 100, column: 0 },
    original: { line: 100, column: 0 },
    source: '.original.js'
  });
  return sourceMap;
}

function createSingleLineSourceMap() {
  var sourceMap = createEmptySourceMap();
  sourceMap.addMapping({
    generated: { line: 1, column: 0 },
    original: { line: 1, column: 0 },
    source: '.original.js'
  });
  return sourceMap;
}

function createSecondLineSourceMap() {
  var sourceMap = createEmptySourceMap();
  sourceMap.addMapping({
    generated: { line: 2, column: 0 },
    original: { line: 1, column: 0 },
    source: '.original.js'
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
      source: 'original.js'
    });
    original += '    line ' + i + '\n';
  }
  sourceMap.setSourceContent('original.js', original);
  return sourceMap;
}

async function compareStackTrace(sourceMap, source, expected) {
  // Check once with a separate source map
  fs.writeFileSync('.generated.js.map', sourceMap.toString());
  fs.writeFileSync('.generated.js', 'exports.test = async function() {' +
    source.join('\n') + '};//@ sourceMappingURL=.generated.js.map');
  try {
    delete require.cache[require.resolve('./.generated')];
    await require('./.generated').test();
  } catch (e) {
    compareLines(e.stack.split(/\r\n|\n/), expected);
  }
  fs.unlinkSync('.generated.js');
  fs.unlinkSync('.generated.js.map');

  // Check again with an inline source map (in a data URL)
  fs.writeFileSync('.generated.js', 'exports.test = async function() {' +
    source.join('\n') + '};//@ sourceMappingURL=data:application/json;base64,' +
    bufferFrom(sourceMap.toString()).toString('base64'));
  try {
    delete require.cache[require.resolve('./.generated')];
    await require('./.generated').test();
  } catch (e) {
    compareLines(e.stack.split(/\r\n|\n/), expected);
  }
  fs.unlinkSync('.generated.js');
}

async function compareStdout(sourceMap, source, expected) {
  fs.writeFileSync('.original.js', 'this is the original code');
  fs.writeFileSync('.generated.js.map', sourceMap.toString());
  fs.writeFileSync('.generated.js', source.join('\n') +
    '//@ sourceMappingURL=.generated.js.map');
  const {stdout, stderr} = await child_process_exec('node ./.generated');
  compareLines(
    (stdout + stderr)
      .trim()
      .split(/\r\n|\n/)
      .filter(function (line) { return line !== '' }), // Empty lines are not relevant.
    expected
  );
  fs.unlinkSync('.generated.js');
  fs.unlinkSync('.generated.js.map');
  fs.unlinkSync('.original.js');
}

async function child_process_exec(command) {
  return new Promise((resolve) => {
    child_process.exec(command, (error, stdout, stderr) => {
      resolve({stdout, stderr});
    });
  });
}

it('normal throw', async function() {
  await compareStackTrace(createMultiLineSourceMap(), [
    'throw new Error("test");'
  ], [
    'Error: test',
    /^    at Object\.exports\.test \((?:.*[/\\])?line1\.js:1001:101\)$/
  ]);
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
    /^    at Object\.exports\.test \((?:.*[/\\])?line7\.js:1007:107\)$/
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
    /^    at Object\.exports\.test \((?:.*[/\\])?line4\.js:1004:104\)$/
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
    /^    at Object\.exports\.test \((?:.*[/\\])?line7\.js:1007:107\)$/
  ]);
});

it('eval', async function() {
  await compareStackTrace(createMultiLineSourceMap(), [
    'eval("throw new Error(\'test\')");'
  ], [
    'Error: test',

    // Before Node 4, `Object.eval`, after just `eval`.
    /^    at (?:Object\.)?eval \(eval at (<anonymous>|exports.test) \((?:.*[/\\])?line1\.js:1001:101\)/,

    /^    at Object\.exports\.test \((?:.*[/\\])?line1\.js:1001:101\)$/
  ]);
});

it('eval inside eval', async function() {
  await compareStackTrace(createMultiLineSourceMap(), [
    'eval("eval(\'throw new Error(\\"test\\")\')");'
  ], [
    'Error: test',
    /^    at (?:Object\.)?eval \(eval at (<anonymous>|exports.test) \(eval at (<anonymous>|exports.test) \((?:.*[/\\])?line1\.js:1001:101\)/,
    /^    at (?:Object\.)?eval \(eval at (<anonymous>|exports.test) \((?:.*[/\\])?line1\.js:1001:101\)/,
    /^    at Object\.exports\.test \((?:.*[/\\])?line1\.js:1001:101\)$/
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
    /^    at Object\.exports\.test \((?:.*[/\\])?line4\.js:1004:104\)$/
  ]);
});

it('eval with sourceURL', async function() {
  await compareStackTrace(createMultiLineSourceMap(), [
    'eval("throw new Error(\'test\')//@ sourceURL=sourceURL.js");'
  ], [
    'Error: test',
    /^    at (?:Object\.)?eval \(sourceURL\.js:1:7\)$/,
    /^    at Object\.exports\.test \((?:.*[/\\])?line1\.js:1001:101\)$/
  ]);
});

it('eval with sourceURL inside eval', async function() {
  await compareStackTrace(createMultiLineSourceMap(), [
    'eval("eval(\'throw new Error(\\"test\\")//@ sourceURL=sourceURL.js\')");'
  ], [
    'Error: test',
    /^    at (?:Object\.)?eval \(sourceURL\.js:1:7\)$/,
    /^    at (?:Object\.)?eval \(eval at (<anonymous>|exports.test) \((?:.*[/\\])?line1\.js:1001:101\)/,
    /^    at Object\.exports\.test \((?:.*[/\\])?line1\.js:1001:101\)$/
  ]);
});

it('native function', async function() {
  await compareStackTrace(createSingleLineSourceMap(), [
    '[1].map(function(x) { throw new Error(x); });'
  ], [
    'Error: 1',
    /[/\\].original\.js/,
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

it('async stack frames', async function() {
  await compareStackTrace(createMultiLineSourceMap(), [
    'async function foo() {',
    '    await bar();',
    '}',
    'async function bar() {',
    '    await null;',
    '    throw new Error("test");',
    '}',
    'await foo();',
  ], [
    'Error: test',
    /^    at bar \((?:.*[/\\])?line6\.js:1006:106\)/,
    /^    at async foo \((?:.*[/\\])?line2.js:1002:102\)$/
  ]);
});

it('throw with empty source map', async function() {
  await compareStackTrace(createEmptySourceMap(), [
    'throw new Error("test");'
  ], [
    'Error: test',
    /^    at Object\.exports\.test \((?:.*[/\\])?\.generated.js:1:40\)$/
  ]);
});

it('throw in Timeout with empty source map', async function() {
  await compareStdout(createEmptySourceMap(), [
    'require("./source-map-support").install();',
    'setTimeout(function () {',
    '    throw new Error("this is the error")',
    '})'
  ], [
    /[/\\].generated.js:3$/,
    '    throw new Error("this is the error")',
    /^          \^$/,
    'Error: this is the error',
    /^    at ((null)|(Timeout))\._onTimeout \((?:.*[/\\])?.generated\.js:3:11\)$/
  ]);
});

it('throw with source map with gap', async function() {
  await compareStackTrace(createSourceMapWithGap(), [
    'throw new Error("test");'
  ], [
    'Error: test',
    /^    at Object\.exports\.test \((?:.*[/\\])?\.generated\.js:1:40\)$/
  ]);
});

it('sourcesContent with data URL', async function() {
  await compareStackTrace(createMultiLineSourceMapWithSourcesContent(), [
    'throw new Error("test");'
  ], [
    'Error: test',
    /^    at Object\.exports\.test \((?:.*[/\\])?original\.js:1001:5\)$/
  ]);
});

it('finds the last sourceMappingURL', async function() {
  await compareStackTrace(createMultiLineSourceMapWithSourcesContent(), [
    '//# sourceMappingURL=missing.map.js',  // NB: await compareStackTrace adds another source mapping.
    'throw new Error("test");'
  ], [
    'Error: test',
    /^    at Object\.exports\.test \((?:.*[/\\])?original\.js:1002:5\)$/
  ]);
});

it('maps original name from source', async function() {
  var sourceMap = createEmptySourceMap();
  sourceMap.addMapping({
    generated: { line: 2, column: 8 },
    original: { line: 1000, column: 10 },
    source: '.original.js',
  });
  sourceMap.addMapping({
    generated: { line: 4, column: 0 },
    original: { line: 1002, column: 1 },
    source: ".original.js",
    name: "myOriginalName"
  });
  await compareStackTrace(sourceMap, [
    'function foo() {',
    '  throw new Error("test");',
    '}',
    'foo();'
  ], [
    'Error: test',
    /^    at myOriginalName \((?:.*[/\\])?\.original.js:1000:11\)$/,
    /^    at Object\.exports\.test \((?:.*[/\\])?\.original.js:1002:2\)$/
  ]);
});

it('default options', async function() {
  await compareStdout(createSecondLineSourceMap(), [
    '',
    'function foo() { throw new Error("this is the error"); }',
    'require("./source-map-support").install();',
    'process.nextTick(foo);',
    'process.nextTick(function() { process.exit(1); });'
  ], [
    /[/\\].original\.js:1$/,
    'this is the original code',
    '^',
    'Error: this is the error',
    /^    at foo \((?:.*[/\\])?\.original\.js:1:1\)$/
  ]);
});

it('handleUncaughtExceptions is true', async function() {
  await compareStdout(createSecondLineSourceMap(), [
    '',
    'function foo() { throw new Error("this is the error"); }',
    'require("./source-map-support").install({ handleUncaughtExceptions: true });',
    'process.nextTick(foo);'
  ], [
    /[/\\].original\.js:1$/,
    'this is the original code',
    '^',
    'Error: this is the error',
    /^    at foo \((?:.*[/\\])?\.original\.js:1:1\)$/
  ]);
});

it('handleUncaughtExceptions is false', async function() {
  await compareStdout(createSecondLineSourceMap(), [
    '',
    'function foo() { throw new Error("this is the error"); }',
    'require("./source-map-support").install({ handleUncaughtExceptions: false });',
    'process.nextTick(foo);'
  ], [
    /[/\\].generated.js:2$/,
    'function foo() { throw new Error("this is the error"); }',

    // Before Node 4, the arrow points on the `new`, after on the
    // `throw`.
    /^                 (?:      )?\^$/,

    'Error: this is the error',
    /^    at foo \((?:.*[/\\])?.original\.js:1:1\)$/
  ]);
});

it('default options with empty source map', async function() {
  await compareStdout(createEmptySourceMap(), [
    '',
    'function foo() { throw new Error("this is the error"); }',
    'require("./source-map-support").install();',
    'process.nextTick(foo);'
  ], [
    /[/\\].generated.js:2$/,
    'function foo() { throw new Error("this is the error"); }',
    /^                 (?:      )?\^$/,
    'Error: this is the error',
    /^    at foo \((?:.*[/\\])?.generated.js:2:24\)$/
  ]);
});

it('default options with source map with gap', async function() {
  await compareStdout(createSourceMapWithGap(), [
    '',
    'function foo() { throw new Error("this is the error"); }',
    'require("./source-map-support").install();',
    'process.nextTick(foo);'
  ], [
    /[/\\].generated.js:2$/,
    'function foo() { throw new Error("this is the error"); }',
    /^                 (?:      )?\^$/,
    'Error: this is the error',
    /^    at foo \((?:.*[/\\])?.generated.js:2:24\)$/
  ]);
});

it('specifically requested error source', async function() {
  await compareStdout(createSecondLineSourceMap(), [
    '',
    'function foo() { throw new Error("this is the error"); }',
    'var sms = require("./source-map-support");',
    'sms.install({ handleUncaughtExceptions: false });',
    'process.on("uncaughtException", function (e) { console.log("SRC:" + sms.getErrorSource(e)); });',
    'process.nextTick(foo);'
  ], [
    /^SRC:.*[/\\]\.original\.js:1$/,
    'this is the original code',
    '^'
  ]);
});

it('sourcesContent', async function() {
  await compareStdout(createMultiLineSourceMapWithSourcesContent(), [
    '',
    'function foo() { throw new Error("this is the error"); }',
    'require("./source-map-support").install();',
    'process.nextTick(foo);',
    'process.nextTick(function() { process.exit(1); });'
  ], [
    /[/\\]original\.js:1002$/,
    '    line 2',
    '    ^',
    'Error: this is the error',
    /^    at foo \((?:.*[/\\])?original\.js:1002:5\)$/
  ]);
});

it('missing source maps should also be cached', async function() {
  await compareStdout(createSingleLineSourceMap(), [
    '',
    'var count = 0;',
    'function foo() {',
    '  console.log(new Error("this is the error").stack.split("\\n").slice(0, 2).join("\\n"));',
    '}',
    'require("./source-map-support").install({',
    '  overrideRetrieveSourceMap: true,',
    '  retrieveSourceMap: function(name) {',
    '    if (/\\.generated.js$/.test(name)) count++;',
    '    return null;',
    '  }',
    '});',
    'process.nextTick(foo);',
    'process.nextTick(foo);',
    'process.nextTick(function() { console.log(count); });',
  ], [
    'Error: this is the error',
    /^    at foo \((?:.*[/\\])?.generated.js:4:15\)$/,
    'Error: this is the error',
    /^    at foo \((?:.*[/\\])?.generated.js:4:15\)$/,
    '1', // The retrieval should only be attempted once
  ]);
});

it('should consult all retrieve source map providers', async function() {
  await compareStdout(createSingleLineSourceMap(), [
    '',
    'var count = 0;',
    'function foo() {',
    '  console.log(new Error("this is the error").stack.split("\\n").slice(0, 2).join("\\n"));',
    '}',
    'require("./source-map-support").install({',
    '  retrieveSourceMap: function(name) {',
    '    if (/\\.generated.js$/.test(name)) count++;',
    '    return undefined;',
    '  }',
    '});',
    'require("./source-map-support").install({',
    '  retrieveSourceMap: function(name) {',
    '    if (/\\.generated.js$/.test(name)) {',
    '      count++;',
    '      return ' + JSON.stringify({url: '.original.js', map: createMultiLineSourceMapWithSourcesContent().toJSON()}) + ';',
    '    }',
    '  }',
    '});',
    'process.nextTick(foo);',
    'process.nextTick(foo);',
    'process.nextTick(function() { console.log(count); });',
  ], [
    'Error: this is the error',
    /^    at foo \((?:.*[/\\])?original\.js:1004:5\)$/,
    'Error: this is the error',
    /^    at foo \((?:.*[/\\])?original\.js:1004:5\)$/,
    '1', // The retrieval should only be attempted once
  ]);
});

it('should allow for runtime inline source maps', async function() {
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
    /^    at foo \(.*[/\\]original\.js:1004:5\)$/,
    'Error: this is the error',
    /^    at foo \(.*[/\\]original\.js:1004:5\)$/,
    '0', // The retrieval should only be attempted once
  ]);
});

/* The following test duplicates some of the code in
 * `compareStackTrace` but appends a charset to the
 * source mapping url.
 */
it('finds source maps with charset specified', async function() {
  var sourceMap = createMultiLineSourceMap()
  var source = [ 'throw new Error("test");' ];
  var expected = [
    'Error: test',
    /^    at Object\.exports\.test \((?:.*[/\\])?line1\.js:1001:101\)$/
  ];

  fs.writeFileSync('.generated.js', 'exports.test = async function() {' +
    source.join('\n') + '};//@ sourceMappingURL=data:application/json;charset=utf8;base64,' +
    bufferFrom(sourceMap.toString()).toString('base64'));
  try {
    delete require.cache[require.resolve('./.generated')];
    await require('./.generated').test();
  } catch (e) {
    compareLines(e.stack.split(/\r\n|\n/), expected);
  }
  fs.unlinkSync('.generated.js');
});

/* The following test duplicates some of the code in
 * `await compareStackTrace` but appends some code and a
 * comment to the source mapping url.
 */
it('allows code/comments after sourceMappingURL', async function() {
  var sourceMap = createMultiLineSourceMap()
  var source = [ 'throw new Error("test");' ];
  var expected = [
    'Error: test',
    /^    at Object\.exports\.test \((?:.*[/\\])?line1\.js:1001:101\)$/
  ];

  fs.writeFileSync('.generated.js', 'exports.test = async function() {' +
    source.join('\n') + '};//# sourceMappingURL=data:application/json;base64,' +
    bufferFrom(sourceMap.toString()).toString('base64') +
    '\n// Some comment below the sourceMappingURL\nvar foo = 0;');
  try {
    delete require.cache[require.resolve('./.generated')];
    await require('./.generated').test();
  } catch (e) {
    compareLines(e.stack.split(/\r\n|\n/), expected);
  }
  fs.unlinkSync('.generated.js');
});

it('handleUncaughtExceptions is true with existing listener', async function() {
  var source = [
    'process.on("uncaughtException", function() { /* Silent */ });',
    'function foo() { throw new Error("this is the error"); }',
    'require("./source-map-support").install();',
    'process.nextTick(foo);',
    '//@ sourceMappingURL=.generated.js.map'
  ];

  fs.writeFileSync('.original.js', 'this is the original code');
  fs.writeFileSync('.generated.js.map', createSingleLineSourceMap().toString());
  fs.writeFileSync('.generated.js', source.join('\n'));

  const {stdout, stderr} = await child_process_exec('node ./.generated');
  fs.unlinkSync('.generated.js');
  fs.unlinkSync('.generated.js.map');
  fs.unlinkSync('.original.js');
  assert.equal((stdout + stderr).trim(), '');
});

it('normal console.trace', async function() {
  await compareStdout(createMultiLineSourceMap(), [
    'require("./source-map-support").install();',
    'console.trace("test");'
  ], [
    'Trace: test',
    /^    at Object\.<anonymous> \((?:.*[/\\])?line2\.js:1002:102\)$/
  ]);
});
