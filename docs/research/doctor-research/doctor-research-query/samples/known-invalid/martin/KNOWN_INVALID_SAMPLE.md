# Known invalid sample: Martin

These files are historical display output only. They are deliberately
quarantined and must not be loaded as a golden fixture, benchmark expectation,
few-shot example, production prompt input, or factual source.

Known defects include:

- the profile repeatedly says that Martin was elected to the Chinese Academy
  of Engineering in 2007; the Academy's official 2017 election result lists
  Martin in the Medicine and Health Engineering Division;
- the profile omits the required primary-public-sources section and contains
  generic publication/project shells without item-level identifiers or
  sources;
- the review does not preserve generation-time adapter evidence for its
  identifiers and metadata;
- the whole review file contains about 5,429 Unicode Han characters including
  headings, tables, and references, so its body cannot satisfy the claimed
  6,000-character minimum.

PMID magnitude is not itself a validity signal. PMID `41638692` and
`42236671` are currently resolvable through NCBI, but that does not prove the
sample performed the required verification when it was generated.

Fixture discovery must ignore any path below a `known-invalid` directory and
any directory containing a `KNOWN_INVALID_SAMPLE.md` marker.

Official election source:
https://www.cae.cn/cae/html/main/col280/2017-11/27/20171127085337936142127_1.html
