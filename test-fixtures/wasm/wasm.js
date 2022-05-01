const fs = require('fs');
const path = require('path');

exports.call_js_function = async function(fn) {
  const mod = await WebAssembly.instantiate(
    fs.readFileSync(path.resolve(__dirname, 'wasm.wasm')),
    {
      jsapi: {
        fn
      }
    }
  );
  mod.instance.exports.call_js_function();
}
