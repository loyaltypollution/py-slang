import { toPythonAst, toPythonAstAndResolve } from "./utils";

describe('Regression tests for py-slang', () => {
    test('Issue #2', () => {
        const text = `
def foo():
    pass

    pass
`;
        toPythonAst(text);
    })
    test('Issue #5', () => {
        const text = `
print("hi")
        
print("world")
`;
        toPythonAst(text);
    })
    test('Issue #3', () => {
        const text = `
def foo(
    a,
    b
):
    pass

    pass
`;
        toPythonAst(text);
    })
    test('Issue #9', () => {
        const text = `
add_one = lambda : None
add_one = lambda : True
add_one = lambda : False
`;
        toPythonAst(text);
    })

    test('Issue #35', () => {
        const text = `
def f():
    return g()

def g():
    return 3
`;
        toPythonAstAndResolve(text);
    })
})