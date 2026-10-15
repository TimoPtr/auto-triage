// @ts-check

/** Scale applied to unit-vector components when quantizing to int8. */
export const INT8_SCALE = 127;

/**
 * Quantizes an L2-normalized vector to int8 by scaling to [-127, 127].
 * @param {ArrayLike<number>} vector
 * @returns {Int8Array}
 */
export function quantizeInt8(vector) {
  return Int8Array.from(vector, (v) => Math.max(-INT8_SCALE, Math.min(INT8_SCALE, Math.round(v * INT8_SCALE))));
}

/**
 * Wraps an int8 vector as the blob sqlite-vec expects behind vec_int8().
 * @param {Int8Array} vector
 * @returns {Buffer}
 */
export function toBlob(vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/**
 * @param {Uint8Array} blob
 * @returns {Int8Array}
 */
export function fromBlob(blob) {
  return new Int8Array(blob.buffer, blob.byteOffset, blob.byteLength);
}

/**
 * Cosine similarity recovered from the L2 distance between two int8-scaled unit vectors:
 * cos = 1 - d^2 / (2 * scale^2).
 * @param {number} distance
 * @param {number} [scale]
 * @returns {number}
 */
export function cosineFromL2(distance, scale = INT8_SCALE) {
  return 1 - (distance * distance) / (2 * scale * scale);
}
