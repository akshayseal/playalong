const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const isConfigured = !!(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);

if (!isConfigured) {
  console.warn(
    '[cloudinary] CLOUDINARY_* env vars not set — question image uploads will fail. ' +
    'See README "Persistent image storage" for how to get these three values.'
  );
}

module.exports = { cloudinary, isConfigured };
