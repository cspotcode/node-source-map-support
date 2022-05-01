To test support for WASM stack traces, we have a tiny WASM module that we call
into.

It imports a JS function and exports a WASM function
that, when called, will call the JS function.

When we call the wasm function, it calls back into JS.  We can throw an error
and know that one of the stack frames will be wasm.

The module is described in both text and binary formats.  Compilation from text
to binary format was done using an online tool.  I didn't bother to set up a
build script, opting instead ot store the binary in version control.
