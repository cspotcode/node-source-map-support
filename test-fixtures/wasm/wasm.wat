(module
    (import "jsapi" "fn" (func $jsapi_fn))
    (func (export "call_js_function")
        call $jspapi_fn
    )
)
