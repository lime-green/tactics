canvas = document.getElementById('myCanvas');
originalWidth = canvas.width;
originalHeight = canvas.height;
context = canvas.getContext('2d');

let frame_index = 0;
function drawFrame() {
  frame_index = frame_index === 0 ? 0 : frame_index + 1;

  switch (frame_index) {
  case 0:
    //context.fillStyle = '#000000';
    context.fillStyle = '#dddddd';
    context.fillRect(0, 0, 66, 42);
    context.save();
    context.transform(1, 0, 0, 1, 0, 0);
    context.save();
    context.transform(1, 0, 0, 1, 33, 21);
    context.save();
    context.transform(0.05, 0, 0, 0.05, 0, 0);
    context.beginPath();
    context.moveTo(467, -297);
    context.quadraticCurveTo(660, -174, 660, 0);
    context.quadraticCurveTo(660, 174, 467, 297);
    context.quadraticCurveTo(274, 420, 0, 420);
    context.quadraticCurveTo(-273, 420, -467, 297);
    context.quadraticCurveTo(-660, 174, -660, 0);
    context.quadraticCurveTo(-660, -174, -467, -297);
    context.quadraticCurveTo(-273, -420, 0, -420);
    context.quadraticCurveTo(274, -420, 467, -297);
    context.fillStyle = 'rgba(255,255,255,0)';
    context.fill();
    context.save();
    context.clip();
    context.transform(0.0402984619140625, 0, 0, 0.0256500244140625, 0, 0);
    let gradient0 = context.createRadialGradient(0, 0, 0, 0, 0, 16384);
    gradient0.addColorStop(0, 'rgba(255,255,255,1)');
    gradient0.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient0;
    context.fillRect(-16384, -16384, 32768, 32768);
    context.restore();
    context.restore();
    context.restore();
    context.restore();
    break;
  }
}

setInterval(drawFrame, 83);
