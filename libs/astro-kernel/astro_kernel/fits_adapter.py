"""Parse already-open SPOC FITS HDUs; caller owns IO and astropy dependency."""
import numpy as np

from .preprocessing import PreprocessError, SectorInput, _array, _identifier


def parse_spoc_hdul(hdul, *, product_id: str) -> tuple[SectorInput, dict]:
    """Accept an astropy HDUList. Copy arrays before its file is closed.

    Requires native SPOC BTJD/TDB and electrons/s; never guesses or converts
    an unfamiliar time origin. FITS checksum verification belongs to caller.
    """
    try:
        if not isinstance(product_id, str) or not product_id.strip():
            raise PreprocessError("invalid_identity", "product_id")
        primary, lc = hdul[0].header, hdul[1].header
        table = hdul[1].data
        keys = ("TIMESYS", "BJDREFI", "BJDREFF", "TIMEUNIT", "TIMEDEL")
        meta = {k: lc[k] for k in keys}
        meta.update({k: primary[k] for k in ("TICID", "SECTOR", "PROCVER")})
        _identifier(meta["TICID"], "TICID")
        _identifier(meta["SECTOR"], "SECTOR")
        if (str(meta["TIMESYS"]).strip().upper() != "TDB" or
                str(meta["TIMEUNIT"]).strip().lower() not in ("d", "day") or
                float(meta["BJDREFI"]) != 2457000 or float(meta["BJDREFF"]) != 0 or
                not np.isfinite(float(meta["TIMEDEL"])) or float(meta["TIMEDEL"]) <= 0):
            raise PreprocessError("unsupported_time_metadata", product_id)
        units = {lc[f"TTYPE{i}"]: str(lc.get(f"TUNIT{i}", "")).strip().lower()
                 for i in range(1, int(lc["TFIELDS"]) + 1)}
        for name in ("PDCSAP_FLUX", "PDCSAP_FLUX_ERR"):
            if units.get(name) not in ("e-/s", "electron/s", "electrons/s"):
                raise PreprocessError("unsupported_flux_unit", name)
        if not str(meta["PROCVER"]).strip():
            raise PreprocessError("missing_header", "PROCVER")
        arrays = [_array(table[k], k, integer=k in ("QUALITY", "CADENCENO"))
                  for k in ("TIME", "PDCSAP_FLUX", "PDCSAP_FLUX_ERR", "QUALITY", "CADENCENO")]
        if len({len(a) for a in arrays}) != 1:
            raise PreprocessError("length_mismatch", product_id)
        meta["FLUX_UNIT"] = units["PDCSAP_FLUX"]
        return SectorInput(meta["TICID"], meta["SECTOR"], product_id, *arrays), meta
    except PreprocessError:
        raise
    except KeyError as exc:
        raise PreprocessError("missing_header_or_column", str(exc)) from exc
    except (IndexError, TypeError, ValueError, AttributeError) as exc:
        raise PreprocessError("invalid_fits_structure", product_id) from exc
