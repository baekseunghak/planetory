"""Compatibility import; shared implementation belongs to astro_kernel."""
from astro_kernel.gold_canonical import (  # noqa: F401
    CHECKSUM_VERSION, RECORD_CHECKSUM_VERSION, NULL_HASH_BYTES, RECORD_RULES,
    ArrayCanonicalError, array_checksum, bundle_version, canonical_record_bytes,
    normalize_array, record_checksum, float64_checksum, canonical_bytes,
    normalize_and_checksum, prepare_records,
)
