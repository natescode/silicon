---
title: Rotating cube (native FFI + raylib)
---

# Rotating cube — native FFI with raylib

A complete native program: a six-colour cube you rotate with the arrow keys (or
WASD), rendered with [raylib](https://www.raylib.com/). It shows how Silicon
links a native C library through `@extern` signature lines and the
`[native] libs` manifest entry.

Silicon's FFI passes only **scalars** (`Int` / `Int64` / `Float` / pointers), so
the cube talks to raylib through its primitive-only `rlgl` immediate-mode API and
does all the 3-D maths (rotation, perspective projection, back-face culling)
itself — raylib just opens the window and rasterises the triangles.

Build and run (needs `raylib` + `libm`; install the QBE backend with `sgl setup`):

```sh
sgl build --native examples/cube.si -lraylib -lm
./examples/cube
```

Or declare the libraries once in `sgl.toml` so a bare `sgl build --native` links them:

```toml
[native]
libs = ["raylib", "m"]
```

::: tip Gotcha — C `bool` returns
raylib's `IsKeyDown` / `WindowShouldClose` return a C `bool`, which sets only the
low byte of the return register. They must be declared `-> Bool` (not `-> Int`)
so the backend masks the result to a clean `0`/`1`. Declared `-> Int`, Silicon
reads the garbage upper bits and every key tests as pressed — the directions
cancel and the cube never moves.
:::

## The program

```silicon
\\ @extern InitWindow (Int, Int, String);
\\ @extern SetTargetFPS (Int);
\\ @extern WindowShouldClose () -> Bool;
\\ @extern IsKeyDown (Int) -> Bool;
\\ @extern BeginDrawing ();
\\ @extern EndDrawing ();
\\ @extern CloseWindow ();
\\ @extern GetScreenWidth () -> Int;
\\ @extern GetScreenHeight () -> Int;
\\ @extern rlDisableBackfaceCulling ();
\\ @extern rlClearColor (Int, Int, Int, Int);
\\ @extern rlClearScreenBuffers ();
\\ @extern rlBegin (Int);
\\ @extern rlEnd ();
\\ @extern rlColor4ub (Int, Int, Int, Int);
\\ @extern rlVertex2f (Float, Float);
\\ @extern sinf (Float) -> Float;
\\ @extern cosf (Float) -> Float;

@mut gAngleX := 0.0;
@mut gAngleY := 0.0;
@mut gSinX := 0.0;
@mut gCosX := 1.0;
@mut gSinY := 0.0;
@mut gCosY := 1.0;
pos := 1.0;
@mut neg := 0.0;
@mut gCx := 450.0;
@mut gCy := 350.0;
@mut gFocal := 320.0;

\\ rx (Float, Float, Float) -> Float
@fn rx x, y, z := {
    x * gCosY + (z * gSinY)
};
\\ ry (Float, Float, Float) -> Float
@fn ry x, y, z := {
    z1 := z * gCosY - (x * gSinY);
    y * gCosX - (z1 * gSinX)
};
\\ rz (Float, Float, Float) -> Float
@fn rz x, y, z := {
    z1 := z * gCosY - (x * gSinY);
    y * gSinX + (z1 * gCosX)
};
\\ sx (Float, Float, Float) -> Float
@fn sx x, y, z := {
    ox := rx(x, y, z);
    oz := rz(x, y, z);
    scale := gFocal / (4.0 - oz);
    gCx + (ox * scale)
};
\\ sy (Float, Float, Float) -> Float
@fn sy x, y, z := {
    oy := ry(x, y, z);
    oz := rz(x, y, z);
    scale := gFocal / (4.0 - oz);
    gCy - (oy * scale)
};
\\ normalZ (Float, Float, Float, Float, Float, Float, Float, Float, Float) -> Float
@fn normalZ ax, ay, az, bx, by, bz, cx, cy, cz := {
    rax := rx(ax, ay, az);
    ray := ry(ax, ay, az);
    rbx := rx(bx, by, bz);
    rby := ry(bx, by, bz);
    rcx := rx(cx, cy, cz);
    rcy := ry(cx, cy, cz);
    e1x := rbx - rax;
    e1y := rby - ray;
    e2x := rcx - rax;
    e2y := rcy - ray;
    e1x * e2y - (e1y * e2x)
};
\\ drawFace (Float, Float, Float, Float, Float, Float, Float, Float, Float, Float, Float, Float, Int, Int, Int)
@fn drawFace ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, r, g, b := {
    nz := normalZ(ax, ay, az, bx, by, bz, cx, cy, cz);
    @if(nz > 0.0, {
        ax2 := sx(ax, ay, az);
        ay2 := sy(ax, ay, az);
        bx2 := sx(bx, by, bz);
        by2 := sy(bx, by, bz);
        cx2 := sx(cx, cy, cz);
        cy2 := sy(cx, cy, cz);
        dx2 := sx(dx, dy, dz);
        dy2 := sy(dx, dy, dz);
        rlBegin(4);
        rlColor4ub(r, g, b, 255);
        rlVertex2f(ax2, ay2);
        rlVertex2f(bx2, by2);
        rlVertex2f(cx2, cy2);
        rlVertex2f(ax2, ay2);
        rlVertex2f(cx2, cy2);
        rlVertex2f(dx2, dy2);
        rlEnd();
        0
    });
    0
};
@fn drawCube := {
    drawFace(neg, neg, pos, pos, neg, pos, pos, pos, pos, neg, pos, pos, 230, 41, 55);
    drawFace(pos, neg, neg, neg, neg, neg, neg, pos, neg, pos, pos, neg, 0, 228, 48);
    drawFace(pos, neg, pos, pos, neg, neg, pos, pos, neg, pos, pos, pos, 0, 121, 241);
    drawFace(neg, neg, neg, neg, neg, pos, neg, pos, pos, neg, pos, neg, 253, 249, 0);
    drawFace(neg, pos, pos, pos, pos, pos, pos, pos, neg, neg, pos, neg, 255, 161, 0);
    drawFace(neg, neg, neg, pos, neg, neg, pos, neg, pos, neg, neg, pos, 200, 122, 255);
    0
};
\\ main Int
@fn main := {
    neg = 0.0 - 1.0;
    InitWindow(900, 700, 'Silicon + raylib: rotating cube');
    gCx = @toFloat(GetScreenWidth()) / 2.0;
    gCy = @toFloat(GetScreenHeight()) / 2.0;
    gFocal = @toFloat(GetScreenHeight()) * 0.45;
    SetTargetFPS(60);
    rlDisableBackfaceCulling();
    @loop(WindowShouldClose() == 0, {
        @if(IsKeyDown(263) != 0, { gAngleY = gAngleY - 0.03; });   # left  / A
        @if(IsKeyDown(65)  != 0, { gAngleY = gAngleY - 0.03; });
        @if(IsKeyDown(262) != 0, { gAngleY = gAngleY + 0.03; });   # right / D
        @if(IsKeyDown(68)  != 0, { gAngleY = gAngleY + 0.03; });
        @if(IsKeyDown(265) != 0, { gAngleX = gAngleX - 0.03; });   # up    / W
        @if(IsKeyDown(87)  != 0, { gAngleX = gAngleX - 0.03; });
        @if(IsKeyDown(264) != 0, { gAngleX = gAngleX + 0.03; });   # down  / S
        @if(IsKeyDown(83)  != 0, { gAngleX = gAngleX + 0.03; });
        gCosX = cosf(gAngleX);
        gSinX = sinf(gAngleX);
        gCosY = cosf(gAngleY);
        gSinY = sinf(gAngleY);
        BeginDrawing();
        rlClearColor(24, 24, 32, 255);
        rlClearScreenBuffers();
        drawCube();
        EndDrawing();
    });
    CloseWindow();
    0
};
```

## What to notice

- **`\\ @extern name (Types) -> Ret;`** — each raylib/libc function is declared
  with a body-less signature line. The native backend emits a C call; the linker
  resolves it against `-lraylib -lm`.
- **Scalars only.** Every parameter is `Int` / `Float`. raylib's struct-taking
  high-level API (`DrawCube`, `Camera3D`) is not callable yet, so this uses the
  flat `rlgl` API and projects the vertices in Silicon.
- **Mutable module state** (`@mut gAngleX := …`) holds the rotation; bare
  bindings (`pos := 1.0`) are immutable constants.

See the [Platforms guide](/guide/platforms) for the full native-target and
`@extern` story, and [C interop](/examples/native) for a smaller `@extern` example.
