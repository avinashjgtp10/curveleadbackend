const sharp = require('sharp');
const axios = require('axios');

// Overlays the tenant's logo as a small watermark in the bottom-right corner of a
// base image. Used when attaching a business logo to an AI-generated or uploaded
// WhatsApp template header image.
const LOGO_WIDTH_RATIO = 0.18; // logo width as a fraction of the base image's width
const MARGIN_RATIO = 0.03;     // padding from the edges, as a fraction of image width

const overlayLogo = async (baseBuffer, logoUrl) => {
  const base = sharp(baseBuffer);
  const { width, height } = await base.metadata();
  if (!width || !height) throw new Error('Could not read image dimensions.');

  const logoResponse = await axios.get(logoUrl, { responseType: 'arraybuffer', timeout: 15000 });
  const logoWidth = Math.round(width * LOGO_WIDTH_RATIO);
  const margin = Math.round(width * MARGIN_RATIO);

  const logoBuffer = await sharp(Buffer.from(logoResponse.data))
    .resize({ width: logoWidth, withoutEnlargement: true })
    .png()
    .toBuffer();
  const logoMeta = await sharp(logoBuffer).metadata();

  return base
    .composite([{
      input: logoBuffer,
      left: Math.max(0, width - logoWidth - margin),
      top: Math.max(0, height - (logoMeta.height || logoWidth) - margin),
    }])
    .toBuffer();
};

module.exports = { overlayLogo };
