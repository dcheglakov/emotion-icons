const {toWords} = require('number-to-words')
const execa = require('execa')

const fg = require('fast-glob')
const fs = require('fs-extra')
const ora = require('ora')
const path = require('path')

const h2x = require('./transform/h2x')
const svgo = require('./transform/svgo')

const PACKS = ['fa-regular', 'fa-solid', 'fa-brands', 'feather', 'material', 'octicons']

const SVG_ATTRS = [
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-opacity',
]

let spinner
const camelize=(str) =>str
.split(/[\s\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,\-.\/:;<=>?@\[\]^_`{|}~]+/)
.reduce((res,word,i)=>{
    return word===''?res: res.concat( i>0?word[0].toUpperCase():word[0].toLowerCase() , word.slice(1))
  },'')

  const pascalize=(str) =>str
.split(/[\s\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,\-.\/:;<=>?@\[\]^_`{|}~]+/)
.reduce((res,word)=>{
    return word===''?res:res.concat( word[0].toUpperCase(),word.slice(1))
  },'')



const getComponentName = originalName => {
  originalName = originalName.replace(/^\d+/, digits => `${toWords(parseInt(digits, 10))}_`)
  return originalName.length === 1 ? originalName.toUpperCase() : pascalize(originalName)
}

const getTemplate = () =>
  new Promise((resolve, reject) =>
    fs.readFile(path.join(__dirname, 'templates', 'icon.js.template'), (err, data) => {
      if (err) reject(err)
      else resolve(data.toString())
    }),
  )

const baseDir = path.join(__dirname, '..', 'build')

const generate = async () => {
  spinner = ora('Reading icon packs...').start()

  const icons = (await Promise.all(PACKS.map(pack => require(`./sources/${pack}`)()))).reduce(
    (all, icons) => all.concat(...icons),
    [],
  )

  spinner.text = 'Reading template...'
  const template = await getTemplate()

  spinner.text = 'Clearing desination files...'
  const destinationFiles = ['build', ...PACKS, 'index.js']
  for (const destinationFile of destinationFiles) {
    await fs.remove(path.join(__dirname, '..', destinationFile))
  }
///cross-env BABEL_ENV=es babel build/src/octicons --out-dir build/es
  spinner.text = 'Building icons...'
  const totalIcons = icons.length
  let builtIcons = 0

  for (const icon of icons) {
    const state = {}

    let result = icon.source
    result = await svgo(result)
    result = await h2x(result, state)
    result = result.join(',\n')

    icon.name = getComponentName(icon.originalName)
    icon.height = state.height || icon.height
    icon.width = state.width || icon.width
    icon.viewBox = state.viewBox || `0 0 ${icon.width} ${icon.height}`
    icon.attrs = {fill: 'currentColor'}

    for (const attr of SVG_ATTRS) {
      if (attr in state.attrs) {
        icon.attrs[camelize(attr)] = state.attrs[attr]
      }
    }

    // Special-case the `React` icon
    if (icon.name === 'React') icon.name = 'ReactLogo'

    const component = template
      .replace(/{{attrs}}/g, JSON.stringify(icon.attrs, null, 2).slice(2, -2))
      .replace(/{{height}}/g, icon.height)
      .replace(/{{name}}/g, icon.name)
      .replace(/{{svg}}/g, result)
      .replace(/{{verticalAlign}}/g, icon.verticalAlign || 'middle')
      .replace(/{{viewBox}}/g, icon.viewBox)
      .replace(/{{width}}/g, icon.width)

    const destinationFilename = path.join(baseDir, 'src', icon.pack, `${icon.name}.js`)
    await fs.outputFile(destinationFilename, component)

    spinner.text = `[${++builtIcons} / ${totalIcons}] Built ${icon.pack}/${icon.name}...`
  }

  spinner.text = 'Writing index files...'

  for (const iconPack of PACKS) {
    const seenNames = new Set()

    const packIcons = icons.filter(({pack}) => pack === iconPack)
    await fs.outputFile(
      path.join(baseDir, 'src', iconPack, 'index.js'),

      packIcons
        .map(({name}) => {
          // The Material icon pack has one icon incorrectly in the pack twice
          const seen = seenNames.has(name)
          seenNames.add(name)
          return seen ? null : `export {default as ${name}} from './${name}'`
        })
        .filter(lines => lines)
        .join('\n') +
        `
`,
    )
  }

  await fs.writeFileSync(
    path.join(baseDir, 'src', 'index.js'),
    `
${PACKS.map((pack, idx) => `import * as ${camelize(pack)} from './${pack}'`).join('\n')}



export {${PACKS.map(camelize).join(', ')}}
`,
  )

spinner.text = 'Building ESM JavaScript...'

let compiler  = execa('yarn', [
  'run',
  'build:es'
])
compiler.stdout.pipe(process.stdout)
compiler.stderr.pipe(process.stderr)
await compiler
//"build:es": "cross-env BABEL_ENV=es babel build/src/octicons --out-dir build/es --ignore *.spec.js,*.test.js ",
//"build:cjs": "cross-env BABEL_ENV=cjs babel build/src/octicons --out-dir build/lib --ignore *.spec.js,*.test.js ",
spinner.text = 'Building CJS bundles...'

compiler = execa('yarn', [
  'run',
  'build:cjs'
])
compiler.stdout.pipe(process.stdout)
compiler.stderr.pipe(process.stderr)
await compiler

spinner.text = 'Copying files to destination...'
const builtFiles = [...PACKS, 'index.js']
for (const builtFile of builtFiles) {
  await fs.remove(path.join(__dirname, '..', builtFile))
  await fs.move(path.join(baseDir, 'icons', builtFile), path.join(__dirname, '..', builtFile))
}

const cjsFiles = await fg('build/icons-cjs/**/*.js')
for (const cjsFile of cjsFiles) {
  const destination = path.join(
    __dirname,
    '..',
    cjsFile.replace('build/icons-cjs/', '').replace(/\.js$/, '.cjs.js'),
  )
  await fs.move(path.join(__dirname, '..', cjsFile), destination)
}

spinner.text = 'Writing icon manifest for website...'
const seenImports = new Set()
await fs.writeJSON(
  path.join(__dirname, '..', 'manifest.json'),
  icons
    .map(({name, originalName, pack}) => {
      const importPath = `emotion-icons/${pack}/${name}`

      if (seenImports.has(importPath)) return null
      seenImports.add(importPath)

      return {
        importPath,
        name,
        originalName,
        pack,
      }
    })
    .filter(icon => icon),
)

spinner.succeed(`${totalIcons} icons successfully built!`)
}

generate().catch(err => {
  if (spinner) {
    spinner.fail(err.stack)
  } else {
    console.error(err.stack)
  }
  process.exit(1)
})