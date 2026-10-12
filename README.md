# Devsense' PHP MCP Server

Standalone MCP Server built on `devsense-php-ls`, the DEVSENSE PHP Language Server.

## Installation

Install `devsense-php-mcp` package as a global command line tool:

> npm install -g devsense-php-mcp

## Sample usage

> devsense-php-mcp -p 9101 .

## Available options

```
Usage: devsense-php-mcp [options] [path...]

Arguments:
  path                      Files or directories to be indexed. `**/*.php` by default.

Options:
  -p, --mcp-port            Specify the MCP server port number.
  -r, --root                Root PHP workspace directory. Current directory by default.
  -h, --help                Display help for command
```

## Background

The tool uses [PHP Tools](https://www.devsense.com/)' language server which provides MCP Server functionality.

## More details

- [MCP Tools List](https://docs.devsense.com/other/mcp/mcptools-list/)
- [Overview](https://docs.devsense.com/other/mcp/)
