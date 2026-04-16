{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE ScopedTypeVariables #-}

-- | hie-reader: Reads GHC .hie files and outputs NDJSON to stdout.
--
-- Each line is a JSON object representing one module:
-- {
--   "module": "Module.Name",
--   "srcFile": "relative/path.hs",
--   "declarations": [ { "name": ..., "kind": ..., "lineStart": ..., ... } ],
--   "references": [ { "fromDecl": ..., "toModule": ..., "toName": ..., "line": ... } ],
--   "imports": [ { "module": ..., "qualified": ..., "alias": ... } ]
-- }
--
-- Usage: hie-reader --hie-dir <path> --src-dir <path>
--
-- Requirements:
--   - Must be compiled with the SAME GHC version that produced the .hie files.
--   - HIE files are not portable across GHC major versions.
--
-- Build:
--   nix build       (edit flake.nix to set the matching ghcXYZ package)
--   OR: cabal build (requires the matching GHC version in PATH)

module Main where

import System.Environment (getArgs)
import System.Directory (doesDirectoryExist, listDirectory, doesFileExist)
import System.FilePath ((</>), takeExtension, makeRelative)
import System.IO (hPutStrLn, stderr, hFlush, stdout)
import Data.List (isPrefixOf)

-- NOTE: The actual HIE reading logic requires GHC's internal libraries.
-- This scaffold provides the CLI interface and file discovery.
-- The full implementation using GHC.Iface.Ext.Binary will be added
-- when building with the correct GHC version.
--
-- For now, this outputs a placeholder message per .hie file found.

main :: IO ()
main = do
  args <- getArgs
  case parseArgs args of
    Nothing -> do
      hPutStrLn stderr "Usage: hie-reader --hie-dir <path> [--src-dir <path>]"
      hPutStrLn stderr ""
      hPutStrLn stderr "Reads GHC .hie files and outputs NDJSON to stdout."
      hPutStrLn stderr "Must be compiled with the same GHC version that produced the .hie files."
    Just (hieDir, srcDir) -> do
      hPutStrLn stderr $ "hie-reader: scanning " ++ hieDir
      hieFiles <- findHieFiles hieDir
      hPutStrLn stderr $ "hie-reader: found " ++ show (length hieFiles) ++ " .hie files"
      mapM_ (processHieFile srcDir) hieFiles
      hFlush stdout

data Config = Config
  { cfgHieDir :: FilePath
  , cfgSrcDir :: FilePath
  }

parseArgs :: [String] -> Maybe (FilePath, FilePath)
parseArgs ("--hie-dir" : hieDir : rest) =
  case rest of
    ("--src-dir" : srcDir : _) -> Just (hieDir, srcDir)
    _                          -> Just (hieDir, ".")
parseArgs _ = Nothing

-- | Recursively find all .hie files in a directory.
findHieFiles :: FilePath -> IO [FilePath]
findHieFiles dir = do
  exists <- doesDirectoryExist dir
  if not exists
    then return []
    else do
      entries <- listDirectory dir
      paths <- concat <$> mapM (processEntry dir) entries
      return paths
  where
    processEntry parent entry = do
      let path = parent </> entry
      isDir <- doesDirectoryExist path
      isFile <- doesFileExist path
      if isDir
        then findHieFiles path
        else if isFile && takeExtension entry == ".hie"
             then return [path]
             else return []

-- | Process a single .hie file.
-- TODO: Replace with actual GHC.Iface.Ext.Binary reading.
processHieFile :: FilePath -> FilePath -> IO ()
processHieFile _srcDir hiePath = do
  -- Placeholder: emit minimal JSON for each .hie file found
  -- The real implementation will:
  --   1. Read the .hie file using readHieFile from GHC.Iface.Ext.Binary
  --   2. Extract the HieAST for each module
  --   3. Walk the AST to find declarations, references, and imports
  --   4. Output JSON via Data.Aeson.encode
  hPutStrLn stderr $ "  processing: " ++ hiePath
