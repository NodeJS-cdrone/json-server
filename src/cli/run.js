const fs = require('fs')
const path = require('path')
const _ = require('lodash')
const chalk = require('chalk')
const chokidar = require('chokidar')
const enableDestroy = require('server-destroy')
const pause = require('connect-pause')
const is = require('./utils/is')
const load = require('./utils/load')
const jsonServer = require('../server')

function prettyPrint (argv, object, rules) {
  const host = argv.host === '0.0.0.0' ? 'localhost' : argv.host
  const port = argv.port
  const root = `http://${host}:${port}`

  console.log()
  console.log(chalk.bold('  Resources'))
  for (let prop in object) {
    console.log('  ' + root + '/' + prop)
  }

  if (rules) {
    console.log()
    console.log(chalk.bold('  Other routes'))
    for (var rule in rules) {
      console.log('  ' + rule + ' -> ' + rules[rule])
    }
  }

  console.log()
  console.log(chalk.bold('  Home'))
  console.log('  ' + root)
  console.log()
}

function createApp (source, object, routes, middlewares, argv) {
  const app = jsonServer.create()

  const router = jsonServer.router(
    is.JSON(source)
    ? source
    : object
  )

  const defaultsOpts = {
    logger: !argv.quiet,
    readOnly: argv.readOnly,
    noCors: argv.noCors,
    noGzip: argv.noGzip
  }

  if (argv.static) {
    defaultsOpts.static = path.join(process.cwd(), argv.static)
  }

  const defaults = jsonServer.defaults(defaultsOpts)
  app.use(defaults)

  if (routes) {
    const rewriter = jsonServer.rewriter(routes)
    app.use(rewriter)
  }

  if (middlewares) {
    app.use(middlewares)
  }

  if (argv.delay) {
    app.use(pause(argv.delay))
  }

  router.db._.id = argv.id
  app.db = router.db
  app.use(router)

  return app
}

module.exports = function (argv) {
  const source = argv._[0]
  let app
  let server

  if (!fs.existsSync(argv.snapshots)) {
    console.log(`Error: snapshots directory ${argv.snapshots} doesn't exist`)
    process.exit(1)
  }

  // noop log fn
  if (argv.quiet) {
    console.log = () => {}
  }

  console.log()
  console.log(chalk.cyan('  \\{^_^}/ hi!'))

  function start (cb) {
    console.log()
    console.log(chalk.gray('  Loading', source))

    // Load JSON, JS or HTTP database
    load(source, (err, data) => {
      if (err) throw err

      // Load additional routes
      let routes
      if (argv.routes) {
        console.log(chalk.gray('  Loading', argv.routes))
        routes = JSON.parse(fs.readFileSync(argv.routes))
      }

      // Load middlewares
      let middlewares
      if (argv.middlewares) {
        middlewares = argv.middlewares.map(function (m) {
          console.log(chalk.gray('  Loading', m))
          return require(path.resolve(m))
        })
      }

      // Done
      console.log(chalk.gray('  Done'))

      // Create app and server
      app = createApp(source, data, routes, middlewares, argv)
      server = app.listen(argv.port, argv.host)

      // Enhance with a destroy function
      enableDestroy(server)

      // Display server informations
      prettyPrint(argv, data, routes)

      cb && cb()
    })
  }

  // Start server
  start(() => {
    // Snapshot
    console.log(
      chalk.gray('  Type s + enter at any time to create a snapshot of the database')
    )

    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      if (chunk.trim().toLowerCase() === 's') {
        const filename = 'db-' + Date.now() + '.json'
        const file = path.join(argv.snapshots, filename)
        const state = app.db.getState()
        fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf-8')
        console.log(`  Saved snapshot to ${path.relative(process.cwd(), file)}\n`)
      }
    })

    // Watch files
    if (argv.watch) {
      console.log(chalk.gray('  Watching...'))
      console.log()
      const source = argv._[0]

      // Can't watch URL
      if (is.URL(source)) throw new Error('Can\'t watch URL')

      // Watch .js or .json file
      // Since lowdb uses atomic writing, directory is watched instead of file
      chokidar
        .watch(path.dirname(source))
        .on('change', (file) => {
          if (path.resolve(file) === path.resolve(source)) {
            if (is.JSON(file)) {
              var obj = JSON.parse(fs.readFileSync(file))
              // Compare .json file content with in memory database
              var isDatabaseDifferent = !_.isEqual(obj, app.db.getState())
              if (isDatabaseDifferent) {
                console.log(chalk.gray(`  ${file} has changed, reloading...`))
                server && server.destroy()
                start()
              }
            } else {
              console.log(chalk.gray(`  ${file} has changed, reloading...`))
              server && server.destroy()
              start()
            }
          }
        })

      // Watch routes
      if (argv.routes) {
        chokidar
          .watch(argv.routes)
          .on('change', (file) => {
            console.log(chalk.gray(`  ${file} has changed, reloading...`))
            server && server.destroy()
            start()
          })
      }
    }
  })
}
