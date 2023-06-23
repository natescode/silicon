# Modules

Silicon has an ML-inspired module system. There are three levels to modules.

- Package `package.si`
- Module folder holding `.si` files or `module.si`
- Component any `.si` file

## Package

This is the whole silicon project. Not required to exist. Any folder with a `package.si` is a package.

## Module

Module is any folder that holds `.si` files. It _may_ contain a `module.si` file.

Any module (folder) can be directly imported. Limiting what is exposed can be done within the `module.si` file. That file will be Silicon code (maybe JSON)

## Component

Components are the building blocks of Silicon programs. Any file with the appropriate
extension `.si` is considered a `component`, with the name of the file being the name
of the `component`.

Components help you organize and expose various different kinds of objects,
including:

- functions
- types
- protocols
- extensions
- enums

By default, all contents of an Silicon module are **public** ?? maybe??. The reason for this is everything is
immutable and stateless by default.
