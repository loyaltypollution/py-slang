//
// // // Forbidden identifier
// // text =
// // `
// // async def y():
// //     pass
// // `;
// //
// // Non four indent
// // let text =
// // `
// // def x():
// //    pass
// // `;
//
// // // Unrecognised token
// // text = `
// //             ?
// // `;
//
// // Unterminated string
// // text = `\
// //
// // "abc" "abcdef`;
//
// // // Forbidden operator
// // text =`
// // a @= b
// // `
//
// // // Expected token
// // text = `
// // def a(c, d)
// //     pass
// // `
//
// // // Expected else block
// // text = `
// // if y:
// //     pass
// //
// // `;
//
// // // Expected colon after lambda:
// // text = `
// // x = lambda a
// // `;
//
// // // Expected import
// // text = `
// // from x
// // `;
//
// // // Bad identifier
// // text = `
// // def a(1, 2):
// //     pass
// // `;
//
// // // Missing closing parentheses:
// // text = `
// // def a(a, b:
// //     pass
// // `;
//
// // // @TODO Invalid assign target
// // text = `
// //
// // 1 = 2 def a(b, c):
// //     pass
// // `;
//
// // Variable declaration hoisting
// // text = `
// // x = 1
// // def a():
// //     if True:
// //         x = 1
// //     else:
// //         y = 2
// //     def b():
// //         x = 1
// // `
// // // Undeclared variable
// // text = `
// // x = display(a)
// // `
// // Misspelled name
// // text = `
// // displar(1)
// // `
//
// // // Mispelled name 2
//
// // text = `
// // def y(param):
// //     def z():
// //         var = display(barams)
// // `
//
// // // Name reassignment
//
// // text = `
// // x = 1
// // while True:
// //     pass
// // x = lambda a:a
// // `;
//
// // text = `
// // # !x
// // not x
// // `
//
// // text = `
// // (lambda a:a)(1)
// //
// // `;
//
// // text = `
// // (x)(1)
// // `;
//
// // text = `
// // def a(b,c):
// //     pass
// // `;
//
/* Use as a command line script */
/* npm run start:dev -- test.py */

import { initialise } from "@sourceacademy/conductor";
import PyEvaluator from "./conductor/PyEvaluator";

const {runnerPlugin, conduit} = initialise(PyEvaluator);