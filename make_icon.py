"""Generate the plugin icon: a card outline with a countdown ring."""

from PIL import Image, ImageDraw

SIZE = 512
BLUE = (74, 125, 255, 255)
BLUE_DARK = (44, 88, 210, 255)
WHITE = (255, 255, 255, 255)

img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# Rounded background with a soft vertical gradient.
for y in range(SIZE):
    t = y / (SIZE - 1)
    color = tuple(int(BLUE_DARK[i] + (BLUE[i] - BLUE_DARK[i]) * t) for i in range(3)) + (255,)
    draw.line([(0, y), (SIZE, y)], fill=color)

# Re-mask to rounded corners.
radius = int(SIZE * 0.22)
mask = Image.new('L', (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=radius, fill=255)
img.putalpha(mask)

draw = ImageDraw.Draw(img)

# Card body.
cw, ch = int(SIZE * 0.62), int(SIZE * 0.42)
cx, cy = SIZE // 2, int(SIZE * 0.47)
left, top = cx - cw // 2, cy - ch // 2
right, bottom = left + cw, top + ch
stroke = int(SIZE * 0.032)

draw.rounded_rectangle(
    [left, top, right, bottom],
    radius=int(SIZE * 0.05),
    outline=WHITE,
    width=stroke,
)

# Magnetic stripe.
stripe_y = top + int(ch * 0.30)
draw.line([(left + stroke, stripe_y), (right - stroke, stripe_y)], fill=WHITE, width=stroke)

# Short line standing in for the number row.
line_y = top + int(ch * 0.66)
draw.line(
    [(left + int(cw * 0.12), line_y), (left + int(cw * 0.46), line_y)],
    fill=WHITE,
    width=stroke,
)

# Countdown ring on the lower right, overlapping the card corner.
ring_r = int(SIZE * 0.115)
ring_cx = right - int(SIZE * 0.015)
ring_cy = bottom - int(SIZE * 0.015)

# Punch a hole first so the ring reads clearly over the card edge.
hole_r = ring_r + int(stroke * 0.9)
draw.ellipse([ring_cx - hole_r, ring_cy - hole_r, ring_cx + hole_r, ring_cy + hole_r], fill=BLUE)

# Ring: a 3/4 arc, like a countdown running down.
bbox = [ring_cx - ring_r, ring_cy - ring_r, ring_cx + ring_r, ring_cy + ring_r]
draw.arc(bbox, start=-90, end=180, fill=WHITE, width=int(SIZE * 0.026))

# Clock hands.
hand_w = int(SIZE * 0.024)
draw.line([(ring_cx, ring_cy), (ring_cx, ring_cy - int(ring_r * 0.55))], fill=WHITE, width=hand_w)
draw.line([(ring_cx, ring_cy), (ring_cx + int(ring_r * 0.42), ring_cy)], fill=WHITE, width=hand_w)
draw.ellipse(
    [ring_cx - hand_w // 2, ring_cy - hand_w // 2, ring_cx + hand_w // 2, ring_cy + hand_w // 2],
    fill=WHITE,
)

img.save('assets/icon.png')
img.resize((256, 256), Image.LANCZOS).save('assets/icon-256.png')
img.resize((128, 128), Image.LANCZOS).save('assets/icon-128.png')
print('icons written')
