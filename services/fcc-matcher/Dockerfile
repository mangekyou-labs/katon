FROM golang:1.25 AS build
WORKDIR /src
COPY services/fcc-matcher/go.mod services/fcc-matcher/go.sum ./services/fcc-matcher/
WORKDIR /src/services/fcc-matcher
RUN go mod download
WORKDIR /src
COPY services/fcc-matcher ./services/fcc-matcher
WORKDIR /src/services/fcc-matcher
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w' -o /out/fcc-matcher ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/fcc-matcher /fcc-matcher
EXPOSE 6664 6674
ENTRYPOINT ["/fcc-matcher"]
