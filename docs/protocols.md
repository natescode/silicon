## Protocols

Silicon has a unique combination of Phantom Types and Capability Tokens that are first class constructs at the language level.


## Interfaces with more safety

Let's say we have the following I/O interface

```silicon
@interface FileHandle = {
  @fn open: FileHandle;
  @fn read: Bytes;
  @fn write:void bytes:Bytes;
  @fn close: void;
};
```


## Protocol for File Handling

```Silicon
@@protocol FileProtocol FileHandle = {
  # state defines a phantom type to track compile-time state
  @state Closed;
  @state Opened;

  @@transition FileHandle.open = Closed -> Opened;
  @@transition FileHandle.read = Opened -> Opened;
  @@transition FileHandle.write = Opened -> Opened;
  @@transition fileHandle.close = Opened -> Closed;


};
```


## Syntax 

```
    &@if 
        $cond x, $then y,
        $cond a $then b;

``