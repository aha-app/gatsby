// @ts-check
const fs = require(`fs`)
const path = require(`path`)
const crypto = require(`crypto`)

const sortBy = require(`lodash/sortBy`)
const axios = require(`axios`)
const {
  GraphQLObjectType,
  GraphQLBoolean,
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLNonNull,
} = require(`gatsby/graphql`)
const qs = require(`qs`)
const { generateImageData } = require(`gatsby-plugin-image`)
const {
  getGatsbyImageFieldConfig,
} = require(`gatsby-plugin-image/graphql-utils`)
const { stripIndent } = require(`common-tags`)

const cacheImage = require(`./cache-image`)

// By default store the images in `.cache` but allow the user to override
// and store the image cache away from the gatsby cache. After all, the gatsby
// cache is more likely to go stale than the images (which never go stale)
// Note that the same image might be requested multiple times in the same run

if (process.env.GATSBY_REMOTE_CACHE) {
  console.warn(
    `Note: \`GATSBY_REMOTE_CACHE\` will be removed soon because it has been renamed to \`GATSBY_CONTENTFUL_EXPERIMENTAL_REMOTE_CACHE\``
  )
}
if (process.env.GATSBY_CONTENTFUL_EXPERIMENTAL_REMOTE_CACHE) {
  console.warn(
    `Please be aware that the \`GATSBY_CONTENTFUL_EXPERIMENTAL_REMOTE_CACHE\` env flag is not officially supported and could be removed at any time`
  )
}
const REMOTE_CACHE_FOLDER =
  process.env.GATSBY_CONTENTFUL_EXPERIMENTAL_REMOTE_CACHE ??
  process.env.GATSBY_REMOTE_CACHE ??
  path.join(process.cwd(), `.cache/remote_cache`)
const CACHE_IMG_FOLDER = path.join(REMOTE_CACHE_FOLDER, `images`)

// Promises that rejected should stay in this map. Otherwise remove promise and put their data in resolvedBase64Cache
const inFlightBase64Cache = new Map()
// This cache contains the resolved base64 fetches. This prevents async calls for promises that have resolved.
// The images are based on urls with w=20 and should be relatively small (<2kb) but it does stick around in memory
const resolvedBase64Cache = new Map()

const {
  ImageFormatType,
  ImageResizingBehavior,
  ImageCropFocusType,
} = require(`./schemes`)

// @see https://www.contentful.com/developers/docs/references/images-api/#/reference/resizing-&-cropping/specify-width-&-height
const CONTENTFUL_IMAGE_MAX_SIZE = 4000

const isImage = image =>
  [`image/jpeg`, `image/jpg`, `image/png`, `image/webp`, `image/gif`].includes(
    image?.file?.contentType
  )

// Note: this may return a Promise<body>, body (sync), or null
const getBase64Image = imageProps => {
  if (!imageProps) {
    return null
  }

  // We only support images that are delivered through Contentful's Image API
  if (imageProps.baseUrl.indexOf(`images.ctfassets.net`) === -1) {
    return null
  }

  const requestUrl = `https:${imageProps.baseUrl}?w=20`

  // Prefer to return data sync if we already have it
  const alreadyFetched = resolvedBase64Cache.get(requestUrl)
  if (alreadyFetched) {
    return alreadyFetched
  }

  // If already in flight for this url return the same promise as the first call
  const inFlight = inFlightBase64Cache.get(requestUrl)
  if (inFlight) {
    return inFlight
  }

  // Note: sha1 is unsafe for crypto but okay for this particular case
  const shasum = crypto.createHash(`sha1`)
  shasum.update(requestUrl)
  const urlSha = shasum.digest(`hex`)

  // TODO: Find the best place for this step. This is definitely not it.
  fs.mkdirSync(CACHE_IMG_FOLDER, { recursive: true })

  const cacheFile = path.join(CACHE_IMG_FOLDER, urlSha + `.base64`)

  if (fs.existsSync(cacheFile)) {
    // TODO: against dogma, confirm whether readFileSync is indeed slower
    const promise = fs.promises.readFile(cacheFile, `utf8`)
    inFlightBase64Cache.set(requestUrl, promise)
    return promise.then(body => {
      inFlightBase64Cache.delete(requestUrl)
      resolvedBase64Cache.set(requestUrl, body)
      return body
    })
  }

  const loadImage = async () => {

    console.log(`Fredwin: fetching contentful base64 image ${requestUrl}`);

    let imageResponse, body;
    try {
      imageResponse = await axios.get(requestUrl, {
        responseType: `arraybuffer`,
      })
      const base64 = Buffer.from(imageResponse.data, `binary`).toString(`base64`)

      body = `data:image/jpeg;base64,${base64}`

    } catch (e) {
      console.log(`Fredwin: Contentful timed out fetching image for base64 conversion: ${requestUrl}`);
      throw(e);
      // if we want we can try loading spinners first instead
      body = "data:image/gif;base64,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";
    }

    try {
      // TODO: against dogma, confirm whether writeFileSync is indeed slower
      await fs.promises.writeFile(cacheFile, body)
      return body
    } catch (e) {
      console.error(
        `Contentful:getBase64Image: failed to write ${body.length} bytes remotely fetched from \`${requestUrl}\` to: \`${cacheFile}\`\nError: ${e}`
      )
      throw e
    }
  }

  const promise = loadImage()

  inFlightBase64Cache.set(requestUrl, promise)

  return promise.then(body => {
    inFlightBase64Cache.delete(requestUrl)
    resolvedBase64Cache.set(requestUrl, body)
    return body
  })
}

const getBasicImageProps = (image, args) => {
  let aspectRatio
  if (args.width && args.height) {
    aspectRatio = args.width / args.height
  } else {
    aspectRatio =
      image.file.details.image.width / image.file.details.image.height
  }

  return {
    baseUrl: image.file.url,
    contentType: image.file.contentType,
    aspectRatio,
    width: image.file.details.image.width,
    height: image.file.details.image.height,
  }
}

const createUrl = (imgUrl, options = {}) => {
  // Convert to Contentful names and filter out undefined/null values.
  const urlArgs = {
    w: options.width || undefined,
    h: options.height || undefined,
    fl:
      options.toFormat === `jpg` && options.jpegProgressive
        ? `progressive`
        : undefined,
    q: options.quality || undefined,
    fm: options.toFormat || undefined,
    fit: options.resizingBehavior || undefined,
    f: options.cropFocus || undefined,
    bg: options.background || undefined,
  }

  // Note: qs will ignore keys that are `undefined`. `qs.stringify({a: undefined, b: null, c: 1})` => `b=&c=1`
  return `${imgUrl}?${qs.stringify(urlArgs)}`
}
exports.createUrl = createUrl

const generateImageSource = (
  filename,
  width,
  height,
  toFormat,
  _fit, // We use resizingBehavior instead
  { jpegProgressive, quality, cropFocus, backgroundColor, resizingBehavior }
) => {
  const src = createUrl(filename, {
    width,
    height,
    toFormat,
    resizingBehavior,
    background: backgroundColor?.replace(`#`, `rgb:`),
    quality,
    jpegProgressive,
    cropFocus,
  })
  return { width, height, format: toFormat, src }
}

exports.generateImageSource = generateImageSource

const fitMap = new Map([
  [`pad`, `contain`],
  [`fill`, `cover`],
  [`scale`, `fill`],
  [`crop`, `cover`],
  [`thumb`, `cover`],
])

const resolveFixed = (image, options) => {
  if (!isImage(image)) return null

  const { baseUrl, width, aspectRatio } = getBasicImageProps(image, options)

  let desiredAspectRatio = aspectRatio

  // If no dimension is given, set a default width
  if (options.width === undefined && options.height === undefined) {
    options.width = 400
  }

  // If only a height is given, calculate the width based on the height and the aspect ratio
  if (options.height !== undefined && options.width === undefined) {
    options.width = Math.round(options.height * desiredAspectRatio)
  }

  // If we're cropping, calculate the specified aspect ratio.
  if (options.width !== undefined && options.height !== undefined) {
    desiredAspectRatio = options.width / options.height
  }

  // If the user selected a height and width (so cropping) and fit option
  // is not set, we'll set our defaults
  if (options.width !== undefined && options.height !== undefined) {
    if (!options.resizingBehavior) {
      options.resizingBehavior = `fill`
    }
  }

  // Create sizes (in width) for the image. If the width of the
  // image is 800px, the sizes would then be: 800, 1200, 1600,
  // 2400.
  //
  // This is enough sizes to provide close to the optimal image size for every
  // device size / screen resolution
  let fixedSizes = []
  fixedSizes.push(options.width)
  fixedSizes.push(options.width * 1.5)
  fixedSizes.push(options.width * 2)
  fixedSizes.push(options.width * 3)
  fixedSizes = fixedSizes.map(Math.round)

  // Filter out sizes larger than the image's width and the contentful image's max size.
  const filteredSizes = fixedSizes.filter(size => {
    const calculatedHeight = Math.round(size / desiredAspectRatio)
    return (
      size <= CONTENTFUL_IMAGE_MAX_SIZE &&
      calculatedHeight <= CONTENTFUL_IMAGE_MAX_SIZE &&
      size <= width
    )
  })

  // Sort sizes for prettiness.
  const sortedSizes = sortBy(filteredSizes)

  // Create the srcSet.
  const srcSet = sortedSizes
    .map((size, i) => {
      let resolution
      switch (i) {
        case 0:
          resolution = `1x`
          break
        case 1:
          resolution = `1.5x`
          break
        case 2:
          resolution = `2x`
          break
        case 3:
          resolution = `3x`
          break
        default:
      }
      const h = Math.round(size / desiredAspectRatio)
      return `${createUrl(baseUrl, {
        ...options,
        width: size,
        height: h,
      })} ${resolution}`
    })
    .join(`,\n`)

  let pickedHeight, pickedWidth
  if (options.height) {
    pickedHeight = options.height
    pickedWidth = options.height * desiredAspectRatio
  } else {
    pickedHeight = options.width / desiredAspectRatio
    pickedWidth = options.width
  }

  return {
    aspectRatio: desiredAspectRatio,
    baseUrl,
    width: Math.round(pickedWidth),
    height: Math.round(pickedHeight),
    src: createUrl(baseUrl, {
      ...options,
      width: options.width,
    }),
    srcSet,
  }
}
exports.resolveFixed = resolveFixed

const resolveFluid = (image, options) => {
  if (!isImage(image)) return null

  const { baseUrl, width, aspectRatio } = getBasicImageProps(image, options)

  let desiredAspectRatio = aspectRatio

  // If no dimension is given, set a default maxWidth
  if (options.maxWidth === undefined && options.maxHeight === undefined) {
    options.maxWidth = 800
  }

  // If only a maxHeight is given, calculate the maxWidth based on the height and the aspect ratio
  if (options.maxHeight !== undefined && options.maxWidth === undefined) {
    options.maxWidth = Math.round(options.maxHeight * desiredAspectRatio)
  }

  // If we're cropping, calculate the specified aspect ratio.
  if (options.maxHeight !== undefined && options.maxWidth !== undefined) {
    desiredAspectRatio = options.maxWidth / options.maxHeight
  }

  // If the users didn't set a default sizes, we'll make one.
  if (!options.sizes) {
    options.sizes = `(max-width: ${options.maxWidth}px) 100vw, ${options.maxWidth}px`
  }

  // Create sizes (in width) for the image. If the max width of the container
  // for the rendered markdown file is 800px, the sizes would then be: 200,
  // 400, 800, 1200, 1600, 2400.
  //
  // This is enough sizes to provide close to the optimal image size for every
  // device size / screen resolution
  let fluidSizes = []
  fluidSizes.push(options.maxWidth / 4)
  fluidSizes.push(options.maxWidth / 2)
  fluidSizes.push(options.maxWidth)
  fluidSizes.push(options.maxWidth * 1.5)
  fluidSizes.push(options.maxWidth * 2)
  fluidSizes.push(options.maxWidth * 3)
  fluidSizes = fluidSizes.map(Math.round)

  // Filter out sizes larger than the image's maxWidth and the contentful image's max size.
  const filteredSizes = fluidSizes.filter(size => {
    const calculatedHeight = Math.round(size / desiredAspectRatio)
    return (
      size <= CONTENTFUL_IMAGE_MAX_SIZE &&
      calculatedHeight <= CONTENTFUL_IMAGE_MAX_SIZE &&
      size <= width
    )
  })

  // Add the original image (if it isn't already in there) to ensure the largest image possible
  // is available for small images.
  if (
    !filteredSizes.includes(width) &&
    width < CONTENTFUL_IMAGE_MAX_SIZE &&
    Math.round(width / desiredAspectRatio) < CONTENTFUL_IMAGE_MAX_SIZE
  ) {
    filteredSizes.push(width)
  }

  // Sort sizes for prettiness.
  const sortedSizes = sortBy(filteredSizes)

  // Create the srcSet.
  const srcSet = sortedSizes
    .map(width => {
      const h = Math.round(width / desiredAspectRatio)
      return `${createUrl(image.file.url, {
        ...options,
        width,
        height: h,
      })} ${Math.round(width)}w`
    })
    .join(`,\n`)

  return {
    aspectRatio: desiredAspectRatio,
    baseUrl,
    src: createUrl(baseUrl, {
      ...options,
      width: options.maxWidth,
      height: options.maxHeight,
    }),
    srcSet,
    sizes: options.sizes,
  }
}
exports.resolveFluid = resolveFluid

const resolveResize = (image, options) => {
  if (!isImage(image)) return null

  const { baseUrl, aspectRatio } = getBasicImageProps(image, options)

  // If no dimension is given, set a default width
  if (options.width === undefined && options.height === undefined) {
    options.width = 400
  }

  // If the user selected a height and width (so cropping) and fit option
  // is not set, we'll set our defaults
  if (options.width !== undefined && options.height !== undefined) {
    if (!options.resizingBehavior) {
      options.resizingBehavior = `fill`
    }
  }

  let pickedHeight = options.height,
    pickedWidth = options.width

  if (pickedWidth === undefined) {
    pickedWidth = pickedHeight * aspectRatio
  }

  if (pickedHeight === undefined) {
    pickedHeight = pickedWidth / aspectRatio
  }

  return {
    src: createUrl(image.file.url, options),
    width: Math.round(pickedWidth),
    height: Math.round(pickedHeight),
    aspectRatio,
    baseUrl,
  }
}

exports.resolveResize = resolveResize

const fixedNodeType = ({ name, getTracedSVG }) => {
  return {
    type: new GraphQLObjectType({
      name: name,
      fields: {
        base64: {
          type: GraphQLString,
          resolve: getBase64Image,
        },
        tracedSVG: {
          type: GraphQLString,
          resolve: getTracedSVG,
        },
        aspectRatio: { type: GraphQLFloat },
        width: { type: new GraphQLNonNull(GraphQLFloat) },
        height: { type: new GraphQLNonNull(GraphQLFloat) },
        src: { type: new GraphQLNonNull(GraphQLString) },
        srcSet: { type: new GraphQLNonNull(GraphQLString) },
        srcWebp: {
          type: GraphQLString,
          resolve({ image, options }) {
            if (
              image?.file?.contentType === `image/webp` ||
              options.toFormat === `webp`
            ) {
              return null
            }

            const fixed = resolveFixed(image, {
              ...options,
              toFormat: `webp`,
            })
            return fixed?.src
          },
        },
        srcSetWebp: {
          type: GraphQLString,
          resolve({ image, options }) {
            if (
              image?.file?.contentType === `image/webp` ||
              options.toFormat === `webp`
            ) {
              return null
            }

            const fixed = resolveFixed(image, {
              ...options,
              toFormat: `webp`,
            })
            return fixed?.srcSet
          },
        },
      },
    }),
    args: {
      width: {
        type: GraphQLInt,
      },
      height: {
        type: GraphQLInt,
      },
      quality: {
        type: GraphQLInt,
        defaultValue: 50,
      },
      toFormat: {
        type: ImageFormatType,
        defaultValue: ``,
      },
      resizingBehavior: {
        type: ImageResizingBehavior,
      },
      cropFocus: {
        type: ImageCropFocusType,
        defaultValue: null,
      },
      background: {
        type: GraphQLString,
        defaultValue: null,
      },
    },
    resolve(image, options, context) {
      const node = resolveFixed(image, options)
      if (!node) return null

      return {
        ...node,
        image,
        options,
        context,
      }
    },
  }
}

const fluidNodeType = ({ name, getTracedSVG }) => {
  return {
    type: new GraphQLObjectType({
      name: name,
      fields: {
        base64: {
          type: GraphQLString,
          resolve: getBase64Image,
        },
        tracedSVG: {
          type: GraphQLString,
          resolve: getTracedSVG,
        },
        aspectRatio: { type: new GraphQLNonNull(GraphQLFloat) },
        src: { type: new GraphQLNonNull(GraphQLString) },
        srcSet: { type: new GraphQLNonNull(GraphQLString) },
        srcWebp: {
          type: GraphQLString,
          resolve({ image, options }) {
            if (
              image?.file?.contentType === `image/webp` ||
              options.toFormat === `webp`
            ) {
              return null
            }

            const fluid = resolveFluid(image, {
              ...options,
              toFormat: `webp`,
            })
            return fluid?.src
          },
        },
        srcSetWebp: {
          type: GraphQLString,
          resolve({ image, options }) {
            if (
              image?.file?.contentType === `image/webp` ||
              options.toFormat === `webp`
            ) {
              return null
            }

            const fluid = resolveFluid(image, {
              ...options,
              toFormat: `webp`,
            })
            return fluid?.srcSet
          },
        },
        sizes: { type: new GraphQLNonNull(GraphQLString) },
      },
    }),
    args: {
      maxWidth: {
        type: GraphQLInt,
      },
      maxHeight: {
        type: GraphQLInt,
      },
      quality: {
        type: GraphQLInt,
        defaultValue: 50,
      },
      toFormat: {
        type: ImageFormatType,
        defaultValue: ``,
      },
      resizingBehavior: {
        type: ImageResizingBehavior,
      },
      cropFocus: {
        type: ImageCropFocusType,
        defaultValue: null,
      },
      background: {
        type: GraphQLString,
        defaultValue: null,
      },
      sizes: {
        type: GraphQLString,
      },
    },
    resolve(image, options, context) {
      const node = resolveFluid(image, options)
      if (!node) return null

      return {
        ...node,
        image,
        options,
        context,
      }
    },
  }
}

let warnedForBeta = false

exports.extendNodeType = ({ type, store, reporter }) => {
  if (type.name !== `ContentfulAsset`) {
    return {}
  }

  const getTracedSVG = async args => {
    const { traceSVG } = require(`gatsby-plugin-sharp`)

    const { image, options } = args
    const {
      file: { contentType },
    } = image

    if (contentType.indexOf(`image/`) !== 0) {
      return null
    }

    const absolutePath = await cacheImage(store, image, options)
    const extension = path.extname(absolutePath)

    return traceSVG({
      file: {
        internal: image.internal,
        name: image.file.fileName,
        extension,
        absolutePath,
      },
      args: { toFormat: `` },
      fileArgs: options,
    })
  }

  const getDominantColor = async ({ image, options }) => {
    try {
      const absolutePath = await cacheImage(store, image, options)

      const pluginSharp = require(`gatsby-plugin-sharp`)
      if (!(`getDominantColor` in pluginSharp)) {
        console.error(
          `[gatsby-source-contentful] Please upgrade gatsby-plugin-sharp`
        )
        return `rgba(0,0,0,0.5)`
      }

      return pluginSharp.getDominantColor(absolutePath)
    } catch (e) {
      console.error(
        `[gatsby-source-contentful] Please install gatsby-plugin-sharp`
      )
      return `rgba(0,0,0,0.5)`
    }
  }

  const resolveGatsbyImageData = async (image, options) => {
    const { baseUrl, ...sourceMetadata } = getBasicImageProps(image, options)

    const imageProps = generateImageData({
      ...options,
      pluginName: `gatsby-source-contentful`,
      sourceMetadata,
      filename: baseUrl,
      generateImageSource,
      fit: fitMap.get(options.resizingBehavior),
      options,
    })

    let placeholderDataURI = null

    if (options.placeholder === `dominantColor`) {
      imageProps.backgroundColor = await getDominantColor({
        image,
        options,
      })
    }

    if (options.placeholder === `blurred`) {
      placeholderDataURI = await getBase64Image({
        baseUrl,
      })
    }

    if (options.placeholder === `tracedSVG`) {
      placeholderDataURI = await getTracedSVG({
        image,
        options,
      })
    }

    if (placeholderDataURI) {
      imageProps.placeholder = { fallback: placeholderDataURI }
    }

    return imageProps
  }

  // TODO: Remove resolutionsNode and sizesNode for Gatsby v3
  const fixedNode = fixedNodeType({ name: `ContentfulFixed`, getTracedSVG })
  const resolutionsNode = fixedNodeType({
    name: `ContentfulResolutions`,
    getTracedSVG,
  })
  resolutionsNode.deprecationReason = `Resolutions was deprecated in Gatsby v2. It's been renamed to "fixed" https://example.com/write-docs-and-fix-this-example-link`

  const fluidNode = fluidNodeType({ name: `ContentfulFluid`, getTracedSVG })
  const sizesNode = fluidNodeType({ name: `ContentfulSizes`, getTracedSVG })
  sizesNode.deprecationReason = `Sizes was deprecated in Gatsby v2. It's been renamed to "fluid" https://example.com/write-docs-and-fix-this-example-link`

  // gatsby-plugin-image
  const getGatsbyImageData = () => {
    if (!warnedForBeta) {
      reporter.warn(
        stripIndent`
      Thank you for trying the beta version of the \`gatsbyImageData\` API. Please provide feedback and report any issues at: https://github.com/gatsbyjs/gatsby/discussions/27950`
      )
      warnedForBeta = true
    }

    return getGatsbyImageFieldConfig(resolveGatsbyImageData, {
      jpegProgressive: {
        type: GraphQLBoolean,
        defaultValue: true,
      },
      resizingBehavior: {
        type: ImageResizingBehavior,
      },
      cropFocus: {
        type: ImageCropFocusType,
      },
      quality: {
        type: GraphQLInt,
        defaultValue: 50,
      },
      backgroundColor: {
        type: GraphQLString,
      },
    })
  }

  return {
    fixed: fixedNode,
    resolutions: resolutionsNode,
    fluid: fluidNode,
    sizes: sizesNode,
    gatsbyImageData: getGatsbyImageData(),
    resize: {
      type: new GraphQLObjectType({
        name: `ContentfulResize`,
        fields: {
          base64: {
            type: GraphQLString,
            resolve: getBase64Image,
          },
          tracedSVG: {
            type: GraphQLString,
            resolve: getTracedSVG,
          },
          src: { type: GraphQLString },
          width: { type: GraphQLInt },
          height: { type: GraphQLInt },
          aspectRatio: { type: GraphQLFloat },
        },
      }),
      args: {
        width: {
          type: GraphQLInt,
        },
        height: {
          type: GraphQLInt,
        },
        quality: {
          type: GraphQLInt,
          defaultValue: 50,
        },
        jpegProgressive: {
          type: GraphQLBoolean,
          defaultValue: true,
        },
        resizingBehavior: {
          type: ImageResizingBehavior,
        },
        toFormat: {
          type: ImageFormatType,
          defaultValue: ``,
        },
        cropFocus: {
          type: ImageCropFocusType,
          defaultValue: null,
        },
        background: {
          type: GraphQLString,
          defaultValue: null,
        },
      },
      resolve(image, options) {
        return resolveResize(image, options)
      },
    },
  }
}
