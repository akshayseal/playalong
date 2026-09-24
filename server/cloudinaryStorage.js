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
    let finished = false;
    const finish = (err, result) => {
      if (finished) return; // upload_stream's callback and a stream 'error'
      finished = true;      // event can both fire — only act on the first.
      if (err) cb(err); else cb(null, result);
    };

    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: this.folder, public_id: uuid(), resource_type: 'image' },
      (err, result) => {
        if (err) return finish(err);
        finish(null, {
          path: result.secure_url,   // used as the stored image_url
          filename: result.public_id,
          size: result.bytes,
        });
      }
    );

    // Without these, a network hiccup or bad Cloudinary credentials throws
    // an unhandled 'error' event on the stream — which crashes the entire
    // Node process, not just this one request. This is the fix for that.
    uploadStream.on('error', (err) => finish(err));
    file.stream.on('error', (err) => finish(err));

    file.stream.pipe(uploadStream);
  }

  _removeFile(req, file, cb) {
    if (!file.filename) return cb(null);
    cloudinary.uploader.destroy(file.filename, () => cb(null));
  }
}

module.exports = { CloudinaryStorage };
