import * as es from 'estree'
import { ancestor, simple, make } from 'acorn-walk/dist/walk'
import * as create from '../utils/astCreator'
import GPULoopDetecter from './loopChecker'
// import { parse } from 'acorn'
import { generate } from 'astring'

/*x
  takes in a node and decides whether it is possible to break down into GPU     library code
*/
class GPUTransformer {
  program: es.Program
  static globalIds = {
    __createKernel: create.identifier('__createKernel')
  }

  // functions needed
  inputArray: es.Expression
  outputArray: es.Identifier
  updateFunction: any

  // parallelizable body
  innerBody: any

  // GPU Loops
  counters: string[]
  end: es.Expression[]

  state: number

  localVar: Set<string>
  outerVariables: any

  targetBody: any

  constructor(program: es.Program) {
    this.program = program
  }

  transform = () => {
    const gpuTranspile = this.gpuTranspile

    // tslint:disable
    simple(
      this.program,
      {
        ForStatement(node: es.ForStatement) {
          gpuTranspile(node)
        }
      },
      make({ ForStatement: () => {} })
    )
    // tslint:enable
  }

  // given a for loop, this function returns a GPU specific body
  gpuTranspile = (node: es.ForStatement) => {
    // set state
    this.state = 0
    this.counters = []
    this.end = []

    this.checkOuterLoops(node)

    // no gpu loops found
    if (this.counters.length === 0 || new Set(this.counters).size !== this.counters.length) {
      return
    }

    console.log(this.counters)
    console.log(this.end)

    this.checkBody(this.innerBody)
    if (this.state === 0) {
      return
    }

    // we know for loop is parallelizable, so let's transpile

    this.getOuterVariables()

    // get proper body using state
    this.getTargetBody(node)

    // get a dictionary as global variables
    console.log(this.outerVariables)
    const p: es.Property[] = []
    for (const key in this.outerVariables) {
      if (this.outerVariables.hasOwnProperty(key)) {
        const val = this.outerVariables[key]
        p.push(create.property(key, val))
      }
    }

    console.log(generate(this.targetBody))
    console.log('MUTATING')

    // create function?
    const params: es.Identifier[] = []
    for (let i = 0; i < this.state; i++) {
      params.push(create.identifier(this.counters[i]))
    }

    const counters: string[] = []
    for (let i = 0; i < this.state; i = i + 1) {
      counters.push(this.counters[i])
    }

    // change math functions to Math.__
    simple(this.targetBody, {
      CallExpression(nx: es.CallExpression) {
        if (nx.callee.type !== 'Identifier') {
          return
        }

        const functionName = nx.callee.name
        console.log(functionName)
        const term = functionName.split('_')[1]
        console.log(term)
        const args: es.Expression[] = nx.arguments as any

        create.mutateToCallExpression(
          nx,
          create.memberExpression(create.identifier('Math'), term),
          args
        )
      }
    })

    // change global variables to be a member access
    const names = [this.outputArray.name, ...this.counters, 'Math']
    const locals = this.localVar
    simple(this.targetBody, {
      Identifier(nx: es.Identifier) {
        if (names.includes(nx.name) || locals.has(nx.name)) {
          return
        }

        console.log(nx)
        create.mutateToMemberExpression(
          nx,
          create.memberExpression(create.identifier('this'), 'constants'),
          create.identifier(nx.name)
        )
      }
    })

    // change any counters to member access
    let threads = ['x']
    if (this.state === 2) threads = ['y', 'x']
    if (this.state === 3) threads = ['z', 'y', 'x']

    simple(this.targetBody, {
      Identifier(nx: es.Identifier) {
        let x = -1
        for (let i = 0; i < counters.length; i = i + 1) {
          if (nx.name === counters[i]) {
            x = i
            break
          }
        }

        if (x === -1) {
          return
        }

        const id = threads[x]
        create.mutateToMemberExpression(
          nx,
          create.memberExpression(create.identifier('this'), 'thread'),
          create.identifier(id)
        )
      }
    })

    // change assignment to a return
    ancestor(this.targetBody, {
      AssignmentExpression(nx: es.AssignmentExpression, ancstor: es.Node[]) {
        // assigning to local val, it's okay
        if (nx.left.type === 'Identifier') {
          return
        }

        if (nx.left.type !== 'MemberExpression') {
          return
        }

        console.log(nx.right.type)
        console.log(nx.right)

        const sz = ancstor.length
        console.log(sz)
        console.log(ancstor[sz - 1])
        console.log(ancstor[sz - 2])

        create.mutateToReturnStatement(ancstor[sz - 2], nx.right)
      }
    })

    const f = create.functionExpression([], this.targetBody)
    console.log(generate(f))

    // mutate node to assignment expression
    create.mutateToExpressionStatement(
      node,
      create.assignmentExpression(
        this.outputArray,
        create.callExpression(
          GPUTransformer.globalIds.__createKernel,
          [create.arrayExpression(this.end), create.objectExpression(p), f],
          node.loc!
        )
      )
    )
  }

  // get the body that we want to parallelize
  getTargetBody(node: es.ForStatement) {
    let mv = this.state
    this.targetBody = node
    while (mv > 1) {
      this.targetBody = this.targetBody.body.body[0]
      mv--
    }
    this.targetBody = this.targetBody.body
  }

  /** checker our special loops */

  // count all the for loops
  checkOuterLoops = (node: es.ForStatement) => {
    let currForLoop = node
    while (currForLoop.type === 'ForStatement') {
      this.innerBody = currForLoop.body
      const detector = new GPULoopDetecter(currForLoop)

      if (!detector.ok) {
        break
      }

      this.counters.push(detector.counter)
      this.end.push(detector.end)

      if (this.innerBody.type !== 'BlockStatement') {
        break
      }

      if (this.innerBody.body.length > 1) {
        break
      }

      currForLoop = this.innerBody.body[0]
    }
  }

  /** GPU BODY CHECK */

  // get property access identifiers for the result statement
  getPropertyAccess = (node: es.MemberExpression): string[] => {
    const res: string[] = []
    let ok: boolean = true

    let curr: any = node
    while (curr.type === 'MemberExpression') {
      if (curr.property.type !== 'Identifier') {
        ok = false
        break
      }

      res.push(curr.property.name)
      curr = curr.object
    }

    if (!ok) {
      return []
    }

    this.outputArray = curr
    return res.reverse()
  }

  // check gpu parallelizable body
  checkBody = (node: es.Statement) => {
    let ok: boolean = true

    // check illegal statements
    simple(node, {
      FunctionDeclaration() {
        ok = false
      },
      ArrowFunctionExpression() {
        ok = false
      },
      ReturnStatement() {
        ok = false
      },
      BreakStatement() {
        ok = false
      },
      ContinueStatement() {
        ok = false
      }
    })

    if (!ok) {
      return
    }

    // check function calls are only to math_*
    const mathFuncCheck = new RegExp(/^math_[a-z]+$/)
    simple(node, {
      CallExpression(nx: es.CallExpression) {
        if (nx.callee.type !== 'Identifier') {
          ok = false
          return
        }

        const functionName = nx.callee.name
        if (!mathFuncCheck.test(functionName)) {
          ok = false
          return
        }
      }
    })

    if (!ok) {
      return
    }

    // get all local variables
    const localVar = new Set<string>()
    simple(node, {
      VariableDeclaration(nx: es.VariableDeclaration) {
        if (nx.declarations[0].id.type === 'Identifier') {
          localVar.add(nx.declarations[0].id.name)
        }
      }
    })

    this.localVar = localVar

    // check all assignments and make sure only one global res var assignment
    const resultExpr: es.AssignmentExpression[] = []
    simple(node, {
      AssignmentExpression(nx: es.AssignmentExpression) {
        // assigning to local val, it's okay
        if (nx.left.type === 'Identifier' && localVar.has(nx.left.name)) {
          return
        }

        resultExpr.push(nx)
      }
    })

    // too many assignments!
    if (resultExpr.length !== 1) {
      return
    }

    // not assigning to array
    if (resultExpr[0].left.type !== 'MemberExpression') {
      return
    }

    // check res assignment and its counters
    const res = this.getPropertyAccess(resultExpr[0].left)
    if (res.length === 0 || res.length > this.counters.length) {
      return
    }

    for (let i = 0; i < this.counters.length; i++) {
      if (res[i] !== this.counters[i]) break
      this.state++
    }

    if (this.state > 3) this.state = 3
  }

  // get all variables defined outside the block (on right hand side)
  getOuterVariables() {
    // set some local variables for walking
    const curr: es.BlockStatement = this.innerBody
    const localVar = this.localVar
    const counters = this.counters
    const output = this.outputArray.name

    const externalVar: string[] = []
    simple(curr, {
      Identifier(node: es.Identifier) {
        if (localVar.has(node.name) || counters.includes(node.name) || node.name === output) {
          return
        }

        externalVar.push(node.name)
      }
    })

    // find definition of all externalVar
    const varDefinitions = {}
    const found = {}

    const lineEnd = curr.loc!.start // We assume loc is always there!!
    const prog = this.program
    simple(prog, {
      VariableDeclaration(node: es.VariableDeclaration) {
        const line = node.loc!.start
        if (line > lineEnd) {
          return
        }

        if (node.declarations[0].id.type !== 'Identifier') {
          return
        }

        const nodeName = node.declarations[0].id.name
        if (!externalVar.includes(nodeName)) {
          return
        }

        // check if already found
        if (nodeName in found && found[nodeName] > line) {
          return
        }

        found[nodeName] = line
        varDefinitions[nodeName] = node.declarations[0].init
      },

      AssignmentExpression(node: es.AssignmentExpression) {
        const line = node.loc!.start
        if (line > lineEnd) {
          return
        }

        if (node.left.type !== 'Identifier') {
          return
        }

        const nodeName = node.left.name
        if (!externalVar.includes(nodeName)) {
          return
        }

        // check if already found
        if (nodeName in found && found[nodeName] > line) {
          return
        }

        found[nodeName] = line
        varDefinitions[nodeName] = node.right
      }
    })
    this.outerVariables = varDefinitions
  }
}

export default GPUTransformer