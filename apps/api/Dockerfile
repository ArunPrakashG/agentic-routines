# Agentic Routines API: one small static binary on a base with nothing else in it.
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/api .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/api /usr/local/bin/api
# The container is limited to 128 MB; Go starts collecting before it gets there.
ENV PORT=8080 GOMEMLIMIT=96MiB
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD ["/usr/local/bin/api", "--health"]
ENTRYPOINT ["/usr/local/bin/api"]
