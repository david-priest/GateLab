#!/usr/bin/env Rscript

# Generate the committed, cross-language CyTOF compensation oracle. The numerical
# answers come from R's Lawson-Hanson implementation, not GateLab's TypeScript solver:
#
#   Rscript scripts/generate_cytof_nnls_oracle.R /path/to/PBMC8_30min_patient1_BCR-XL.fcs
#
# The source FCS is public HDCytoData/Bodenmiller benchmark data. Its checksum is
# pinned below; only eight selected event rows are embedded in the output fixture.

suppressPackageStartupMessages({
  library(flowCore)
  library(nnls)
})

args <- commandArgs(trailingOnly = TRUE)
if (length(args) != 1L) {
  stop("Provide the public PBMC8_30min_patient1_BCR-XL.fcs path.", call. = FALSE)
}

source_fcs <- normalizePath(args[[1]], mustWork = TRUE)
source_sha256 <- digest::digest(file = source_fcs, algo = "sha256")
expected_source_sha256 <-
  "d2a70d9d63eb4c99248e14ff508518bc554a065a6fbde59be522a7fabf6a635f"
if (!identical(source_sha256, expected_source_sha256)) {
  stop("The supplied Bodenmiller FCS does not match the pinned public source.", call. = FALSE)
}

normalize_axis <- function(values) {
  values <- trimws(enc2utf8(as.character(values)))
  if (any(!nzchar(values)) || anyDuplicated(values)) {
    stop("Oracle channel axes must be non-empty and unique.", call. = FALSE)
  }
  values
}

canonical_matrix <- function(matrix_input) {
  sources <- normalize_axis(matrix_input$sourceChannels)
  receivers <- normalize_axis(matrix_input$receiverChannels)
  values <- matrix_input$matrix
  if (!is.matrix(values) || !identical(dim(values), c(length(sources), length(receivers)))) {
    stop("Oracle matrix dimensions do not match its axes.", call. = FALSE)
  }
  source_order <- order(sources, method = "radix")
  receiver_order <- order(receivers, method = "radix")
  sources <- sources[source_order]
  receivers <- receivers[receiver_order]
  values <- values[source_order, receiver_order, drop = FALSE]
  for (source_index in seq_along(sources)) {
    diagonal <- match(sources[[source_index]], receivers)
    if (is.na(diagonal) || abs(values[source_index, diagonal] - 1) > 1e-8) {
      stop("Every CyTOF source requires a unit diagonal receiver.", call. = FALSE)
    }
  }
  list(sourceChannels = sources, receiverChannels = receivers, matrix = values)
}

adapt_matrix <- function(canonical, included_channels) {
  included <- sort(normalize_axis(included_channels), method = "radix")
  if (any(!included %in% canonical$receiverChannels)) {
    stop("An included channel is absent from the receiver axis.", call. = FALSE)
  }
  adapted <- diag(1, nrow = length(included), ncol = length(included))
  dimnames(adapted) <- list(included, included)
  imported_sources <- match(included, canonical$sourceChannels)
  imported_receivers <- match(included, canonical$receiverChannels)
  for (source_index in seq_along(included)) {
    imported_source <- imported_sources[[source_index]]
    if (is.na(imported_source)) next
    adapted[source_index, ] <-
      canonical$matrix[imported_source, imported_receivers, drop = TRUE]
    adapted[source_index, source_index] <- 1
  }
  adapted
}

float64_hex <- function(value) {
  value <- as.double(value)
  if (value == 0) value <- 0
  paste(sprintf("%02x", as.integer(writeBin(value, raw(), size = 8L, endian = "big"))),
        collapse = "")
}

json_array <- function(values) unname(lapply(values, jsonlite::unbox))
sha256_text <- function(value) paste0(
  "sha256:",
  digest::digest(charToRaw(enc2utf8(as.character(value))),
                 algo = "sha256", serialize = FALSE)
)

matrix_identity <- function(canonical) {
  matrix_hex <- lapply(seq_len(nrow(canonical$matrix)), function(row) {
    json_array(vapply(canonical$matrix[row, ], float64_hex, character(1)))
  })
  payload <- as.character(jsonlite::toJSON(
    list(
      schema = jsonlite::unbox("gatelab.compensation-matrix.v1"),
      orientation = jsonlite::unbox("source-rows-receiver-columns"),
      sourceChannels = json_array(canonical$sourceChannels),
      receiverChannels = json_array(canonical$receiverChannels),
      matrixHex = matrix_hex
    ),
    auto_unbox = TRUE, digits = NA, null = "null", na = "null", pretty = FALSE
  ))
  list(serialized = payload, hash = sha256_text(payload))
}

profile_hash <- function(matrix_hash, included_channels) {
  settings <- list(
    list(jsonlite::unbox("adaptationVersion"), jsonlite::unbox("string"),
         jsonlite::unbox("identity-backed-v1")),
    list(jsonlite::unbox("kktTolerance"), jsonlite::unbox("number"),
         jsonlite::unbox(float64_hex(1e-9))),
    list(jsonlite::unbox("maxIterations"), jsonlite::unbox("number"),
         jsonlite::unbox(float64_hex(1000))),
    list(jsonlite::unbox("tolerance"), jsonlite::unbox("number"),
         jsonlite::unbox(float64_hex(1e-10)))
  )
  payload <- as.character(jsonlite::toJSON(
    list(
      schema = jsonlite::unbox("gatelab.compensation-profile.v1"),
      kind = jsonlite::unbox("cytof-spillover"),
      method = jsonlite::unbox("nnls"),
      solverVersion = jsonlite::unbox("coordinate-descent-qr-v1"),
      solverSettings = settings,
      matrixHash = jsonlite::unbox(matrix_hash),
      includedChannels = json_array(included_channels)
    ),
    auto_unbox = TRUE, digits = NA, null = "null", na = "null", pretty = FALSE
  ))
  sha256_text(payload)
}

matrix_to_rows <- function(values) {
  lapply(seq_len(nrow(values)), function(row) unname(as.double(values[row, ])))
}

make_matrix_input <- function(source_channels, receiver_channels, coefficients) {
  values <- matrix(0, nrow = length(source_channels), ncol = length(receiver_channels),
                   dimnames = list(source_channels, receiver_channels))
  for (source in source_channels) values[source, source] <- 1
  for (coefficient in coefficients) {
    values[coefficient[[1]], coefficient[[2]]] <- coefficient[[3]]
  }
  list(
    sourceChannels = source_channels,
    receiverChannels = receiver_channels,
    matrix = values
  )
}

solve_case <- function(name,
                       matrix_input,
                       included_channels,
                       input_channels,
                       measured_events,
                       gate) {
  canonical <- canonical_matrix(matrix_input)
  adapted <- adapt_matrix(canonical, included_channels)
  included <- rownames(adapted)
  measured_events <- as.matrix(measured_events)
  storage.mode(measured_events) <- "double"
  colnames(measured_events) <- input_channels
  positions <- match(included, input_channels)
  if (anyNA(positions)) stop("An included channel is absent from the event matrix.", call. = FALSE)
  compensated <- measured_events + 0
  for (event in seq_len(nrow(measured_events))) {
    compensated[event, positions] <-
      as.double(nnls::nnls(t(adapted), measured_events[event, positions])$x)
  }
  matrix_id <- matrix_identity(canonical)
  display_x <- asinh(compensated[, gate$xChannel] / gate$cofactor)
  display_y <- asinh(compensated[, gate$yChannel] / gate$cofactor)
  x_bounds <- sort(vapply(gate$vertices, function(vertex) vertex[[1]], numeric(1)))
  y_bounds <- sort(vapply(gate$vertices, function(vertex) vertex[[2]], numeric(1)))
  members <- which(
    display_x >= x_bounds[[1]] & display_x <= x_bounds[[2]] &
      display_y >= y_bounds[[1]] & display_y <= y_bounds[[2]]
  )
  list(
    name = name,
    matrixInput = list(
      sourceChannels = unname(matrix_input$sourceChannels),
      receiverChannels = unname(matrix_input$receiverChannels),
      matrix = matrix_to_rows(matrix_input$matrix)
    ),
    includedChannels = unname(included),
    inputChannels = unname(input_channels),
    measuredEvents = matrix_to_rows(measured_events),
    expected = list(
      adaptedMatrix = matrix_to_rows(adapted),
      compensatedEvents = matrix_to_rows(compensated),
      matrixHash = matrix_id$hash,
      profileHash = profile_hash(matrix_id$hash, included)
    ),
    gateCheck = list(
      space = "asinh-compensated",
      cofactor = gate$cofactor,
      xChannel = gate$xChannel,
      yChannel = gate$yChannel,
      vertices = gate$vertices,
      memberRowsOneBased = unname(as.integer(members))
    )
  )
}

synthetic_matrix <- make_matrix_input(
  source_channels = c("B", "A"),
  receiver_channels = c("C", "B", "A"),
  coefficients = list(
    list("A", "B", 0.20),
    list("A", "C", 0.10),
    list("B", "A", 0.05),
    list("B", "C", 0.30)
  )
)
synthetic_events <- matrix(c(
  1, 8, 10, 6, 100,
  2, -2, 3, 4, 200,
  3, 0, 0, 0, 300,
  4, 20, 5, -1, 400,
  5, 5, -10, 15, 500,
  6, 100, 90, 80, 600
), ncol = 5, byrow = TRUE)

dynamic_matrix <- make_matrix_input(
  source_channels = c("D", "B", "A", "C"),
  receiver_channels = c("C", "A", "D", "B"),
  coefficients = list(
    list("A", "B", 0.030),
    list("A", "D", 0.010),
    list("B", "A", 0.020),
    list("B", "C", 0.040),
    list("C", "B", 0.010),
    list("C", "D", 0.050),
    list("D", "A", 0.030),
    list("D", "C", 0.020)
  )
)
dynamic_events <- matrix(c(
  40, 77, 20, 100, 5,
  -1, 88, 5, -20, 0.5,
  100000, 99, 20000, 1000000, 5000,
  0, 111, 0, 0, 0,
  1e-8, 22, -1e-8, 2e-8, 1e-8
), ncol = 5, byrow = TRUE)

real_input_channels <- c(
  "Time", "Cell_length", "CD45(In115)Dd", "pNFkB(Nd142)Dd",
  "pp38(Nd144)Dd", "CD4(Nd145)Dd", "CD20(Sm147)Dd", "pStat5(Nd150)Dd"
)
real_source_channels <- c(
  "pStat5(Nd150)Dd", "CD20(Sm147)Dd", "pp38(Nd144)Dd",
  "pNFkB(Nd142)Dd", "CD45(In115)Dd"
)
real_receiver_channels <- c(
  "pStat5(Nd150)Dd", "CD4(Nd145)Dd", "CD45(In115)Dd",
  "pp38(Nd144)Dd", "CD20(Sm147)Dd", "pNFkB(Nd142)Dd"
)
real_matrix <- make_matrix_input(
  source_channels = real_source_channels,
  receiver_channels = real_receiver_channels,
  coefficients = list(
    list("CD45(In115)Dd", "pNFkB(Nd142)Dd", 0.025),
    list("CD45(In115)Dd", "pp38(Nd144)Dd", 0.012),
    list("pNFkB(Nd142)Dd", "pp38(Nd144)Dd", 0.035),
    list("pNFkB(Nd142)Dd", "CD4(Nd145)Dd", 0.010),
    list("pp38(Nd144)Dd", "CD4(Nd145)Dd", 0.045),
    list("pp38(Nd144)Dd", "CD20(Sm147)Dd", 0.015),
    list("CD20(Sm147)Dd", "pStat5(Nd150)Dd", 0.030),
    list("pStat5(Nd150)Dd", "CD20(Sm147)Dd", 0.008)
  )
)
invisible(utils::capture.output(
  frame <- suppressWarnings(flowCore::read.FCS(
    source_fcs, transformation = FALSE, truncate_max_range = FALSE
  )),
  type = "output"
))
event_rows <- c(1L, 2L, 17L, 101L, 500L, 1000L, 2000L, 2838L)
real_events <- flowCore::exprs(frame)[event_rows, real_input_channels, drop = FALSE]

oracle <- list(
  schema = "gatelab.cytof-nnls-oracle.v1",
  orientation = "source-rows-receiver-columns",
  generation = "nnls::nnls(t(identity_backed_S), measured)$x",
  generatedBy = list(
    R = R.version.string,
    nnls = as.character(utils::packageVersion("nnls")),
    flowCore = as.character(utils::packageVersion("flowCore")),
    jsonlite = as.character(utils::packageVersion("jsonlite"))
  ),
  solverContract = list(
    solverVersion = "coordinate-descent-qr-v1",
    solverSettings = list(
      tolerance = 1e-10,
      kktTolerance = 1e-9,
      maxIterations = 1000,
      adaptationVersion = "identity-backed-v1"
    )
  ),
  publicSource = list(
    study = "Bodenmiller et al., Nature Biotechnology 2012",
    doi = "10.1038/nbt.2317",
    distribution = "HDCytoData Bodenmiller_BCR_XL_fcs_files.zip",
    fileName = basename(source_fcs),
    fileSha256 = source_sha256,
    eventRowsOneBased = event_rows
  ),
  cases = list(
    solve_case(
      name = "rectangular receiver-only channel and excluded pass-through",
      matrix_input = synthetic_matrix,
      included_channels = c("C", "A", "B"),
      input_channels = c("Time", "C", "A", "B", "Ir191Di"),
      measured_events = synthetic_events,
      gate = list(
        cofactor = 5,
        xChannel = "A",
        yChannel = "B",
        vertices = list(c(0, 0), c(3.5, 3.5))
      )
    ),
    solve_case(
      name = "coupled sparse boundary and dynamic range",
      matrix_input = dynamic_matrix,
      included_channels = c("D", "A", "C", "B"),
      input_channels = c("D", "Aux", "B", "A", "C"),
      measured_events = dynamic_events,
      gate = list(
        cofactor = 5,
        xChannel = "A",
        yChannel = "D",
        vertices = list(c(1, 1), c(14, 12))
      )
    ),
    solve_case(
      name = "public Bodenmiller events with rectangular spillover import",
      matrix_input = real_matrix,
      included_channels = rev(real_receiver_channels),
      input_channels = real_input_channels,
      measured_events = real_events,
      gate = list(
        cofactor = 5,
        xChannel = "CD45(In115)Dd",
        yChannel = "CD20(Sm147)Dd",
        vertices = list(c(4.5, 0), c(5.7, 1))
      )
    )
  )
)

cat(as.character(jsonlite::toJSON(
  oracle, auto_unbox = TRUE, digits = NA, null = "null", na = "null", pretty = TRUE
)))
cat("\n")
