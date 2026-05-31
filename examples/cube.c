// examples/cube.c — the same six-colour rotating cube as cube.si, but in plain
// C against raylib's high-level API. A control test: if THIS responds to the
// keyboard but the Silicon build doesn't, the problem is the Silicon binary;
// if neither responds, it's raylib / the desktop environment.
//
//   cc examples/cube.c -o examples/cube_c $(pkg-config --libs raylib 2>/dev/null || echo -lraylib) -lm
//   ./examples/cube_c        # arrows / WASD rotate, Esc quits
#include "raylib.h"
#include "rlgl.h"

static void face(unsigned char r, unsigned char g, unsigned char b,
                 float ax, float ay, float az, float bx, float by, float bz,
                 float cx, float cy, float cz, float dx, float dy, float dz) {
    rlColor4ub(r, g, b, 255);
    rlVertex3f(ax, ay, az); rlVertex3f(bx, by, bz);
    rlVertex3f(cx, cy, cz); rlVertex3f(dx, dy, dz);
}

int main(void) {
    InitWindow(900, 700, "raylib C cube (keyboard test)");
    SetTargetFPS(60);

    Camera3D cam = { 0 };
    cam.position   = (Vector3){ 0.0f, 0.0f, 6.0f };
    cam.target     = (Vector3){ 0.0f, 0.0f, 0.0f };
    cam.up         = (Vector3){ 0.0f, 1.0f, 0.0f };
    cam.fovy       = 45.0f;
    cam.projection = CAMERA_PERSPECTIVE;

    float angX = 0.0f, angY = 0.0f;

    while (!WindowShouldClose()) {
        if (IsKeyDown(KEY_RIGHT) || IsKeyDown(KEY_D)) angY += 1.6f;
        if (IsKeyDown(KEY_LEFT)  || IsKeyDown(KEY_A)) angY -= 1.6f;
        if (IsKeyDown(KEY_UP)    || IsKeyDown(KEY_W)) angX -= 1.6f;
        if (IsKeyDown(KEY_DOWN)  || IsKeyDown(KEY_S)) angX += 1.6f;

        BeginDrawing();
        ClearBackground((Color){ 24, 24, 32, 255 });
        BeginMode3D(cam);
            rlPushMatrix();
            rlRotatef(angX, 1.0f, 0.0f, 0.0f);
            rlRotatef(angY, 0.0f, 1.0f, 0.0f);
            rlBegin(RL_QUADS);
                face(230, 41, 55, -1,-1, 1,  1,-1, 1,  1, 1, 1, -1, 1, 1);   // front  red
                face(0, 228, 48,  1,-1,-1, -1,-1,-1, -1, 1,-1,  1, 1,-1);     // back   green
                face(0, 121, 241, 1,-1, 1,  1,-1,-1,  1, 1,-1,  1, 1, 1);     // right  blue
                face(253, 249, 0,-1,-1,-1, -1,-1, 1, -1, 1, 1, -1, 1,-1);     // left   yellow
                face(255, 161, 0,-1, 1, 1,  1, 1, 1,  1, 1,-1, -1, 1,-1);     // top    orange
                face(200, 122, 255,-1,-1,-1, 1,-1,-1,  1,-1, 1, -1,-1, 1);    // bottom purple
            rlEnd();
            rlPopMatrix();
        EndMode3D();
        DrawText("arrows / WASD to rotate, Esc to quit", 12, 12, 20, RAYWHITE);
        EndDrawing();
    }
    CloseWindow();
    return 0;
}
