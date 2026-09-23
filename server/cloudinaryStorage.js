const { v4: uuid } = require('uuid');
const { cloudinary } = require('./cloudinary');

// A Multer storage engine only needs to implement _handleFile and _removeFile.
// This streams the incoming file straight to Cloudinary — nothing ever
// touches local disk, so it works the same on a laptop and on Railway's
// ephemeral filesystem.
class CloudinaryStorage {
  constructor({ folder }) {
    this.folder = folder;
  }

  _handleFile(req, file, cb) {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: this.folder, public_id: uuid(), resource_type: 'image' },
      (err, result) => {
        if (err) return cb(err);
        cb(null, {
          path: result.secure_url,   // used as the stored image_url
          filename: result.public_id,
          size: result.bytes,
        });
      }
    );
    file.stream.pipe(uploadStream);
  }

  _removeFile(req, file, cb) {
    if (!file.filename) return cb(null);
    cloudinary.uploader.destroy(file.filename, () => cb(null));
  }
}

module.exports = { CloudinaryStorage };
