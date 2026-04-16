{
  description = "hie-reader: reads GHC .hie files and outputs NDJSON";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-23.11";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        # GHC version MUST match the version that produced the .hie files.
        # Override via: nix build --override-input ghcPackage <pkgs.haskell.packages.ghcXYZ>
        # Common versions: ghc928, ghc945, ghc964, ghc982
        hsPkgs = pkgs.haskell.packages.ghc928;
      in {
        packages.default = hsPkgs.callCabal2nix "hie-reader" ./. {};

        devShells.default = hsPkgs.shellFor {
          packages = p: [ (hsPkgs.callCabal2nix "hie-reader" ./. {}) ];
          buildInputs = [
            hsPkgs.cabal-install
            hsPkgs.ghc
          ];
        };
      }
    );
}
