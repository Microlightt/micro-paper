"""Self-authored PDFs; no published paper or private data. Output belongs outside the skill."""
import argparse
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from PIL import Image, ImageDraw, ImageFont


def line(c, x, y, s, font='Times-Roman', size=11):
    c.setFont(font, size); c.drawString(x, y, s)


def figure(c, x, y, label, color):
    c.setStrokeColorRGB(.2,.3,.3); c.rect(x,y,230,120)
    line(c,x+10,y+101,label,'Helvetica',10)
    for i,h in enumerate([28,65,45]):
        c.setFillColorRGB(*color); c.rect(x+30+i*60,y+20,25,h,fill=1)
    c.setFillColorRGB(0,0,0); line(c,x+10,y+7,'a  Control     b  Test     c  Replicate','Helvetica',9)


def make(out, long=False):
    path=out/('four-page.pdf' if long else 'two-page.pdf')
    c=canvas.Canvas(str(path),pagesize=(612,792),invariant=1)
    line(c,40,750,'Synthetic study of a measured signal','Times-Bold',17)
    line(c,40,723,'Abstract','Times-Bold',13)
    line(c,40,699,'We measured a signal in 3 samples.')
    line(c,40,680,'The results appear in Fig. 1a-c and')
    line(c,40,661,'Extended Data Fig. 1b.')
    line(c,330,723,'Results','Times-Bold',13)
    line(c,330,699,'The mean increased from 2 to 4 mg.')
    # True PDF italic, superscript and subscript, no synthetic Unicode substitution.
    x,y=330,677
    for s,font,size,dy in [('The ', 'Times-Roman',11,0),('signal','Times-Italic',11,0),(' H','Times-Roman',11,0),('2','Times-Roman',7,-3),('O was 10','Times-Roman',11,0),('3','Times-Roman',7,4),(' units.','Times-Roman',11,0)]:
        line(c,x,y+dy,s,font,size);x+=c.stringWidth(s,font,size)
    line(c,330,651,'See Figs. 1 and 2.' if long else 'No additional comparison was made.')
    figure(c,40,465,'Fig. 1. Signal measurements',(.2,.5,.4))
    line(c,40,438,'Fig. 1. The bars show individual values.')
    line(c,40,419,'The caption continues on the next page:')
    line(c,40,385,'Methods','Times-Bold',13)
    line(c,40,362,'Samples were measured at 20 Hz.')
    line(c,330,385,'References','Times-Bold',13)
    line(c,330,362,'1. Example A. A measurement method.')
    line(c,330,343,'Synthetic Journal 1, 10-12 (2026).')
    c.showPage()
    line(c,40,750,'Fig. 1 caption continued','Times-Bold',13)
    line(c,40,727,'Error bars represent the range of 3 samples.')
    line(c,40,692,'Extended Data','Times-Bold',13)
    figure(c,40,515,'Extended Data Fig. 1. Replicate signal',(.35,.45,.7))
    line(c,40,488,'Extended Data Fig. 1. Replicates agree.')
    line(c,330,692,'Reporting Summary','Times-Bold',13)
    line(c,330,666,'No samples were excluded.')
    line(c,330,647,'The experiment was repeated 3 times.')
    if long:
        c.showPage();line(c,40,750,'Additional results','Times-Bold',13)
        line(c,40,722,'Figs. 1a-c, 2 and Extended Data Fig. 1b')
        line(c,40,703,'show the same direction of change.')
        figure(c,40,495,'Fig. 2. Additional measurement',(.7,.4,.25))
        line(c,40,468,'Fig. 2. The signal was measured again.')
        c.showPage()
        # A genuinely image-only scan page.
        image=Image.new('RGB',(1224,1584),'white');draw=ImageDraw.Draw(image)
        font=ImageFont.load_default(size=30)
        draw.text((80,90),'Reporting Summary continued',font=font,fill='black')
        draw.text((80,150),'All 3 observations are included.',font=font,fill='black')
        draw.text((80,220),'No randomization was performed.',font=font,fill='black')
        c.drawImage(ImageReader(image),0,0,612,792)
    c.save()
    return path


if __name__=='__main__':
    a=argparse.ArgumentParser();a.add_argument('output',type=Path);p=a.parse_args();p.output.mkdir(parents=True,exist_ok=True)
    print(make(p.output));print(make(p.output,True))
    c=canvas.Canvas(str(p.output/'one-page.pdf'),pagesize=(612,792),invariant=1)
    line(c,40,750,'A short independent observation','Times-Bold',17)
    line(c,40,713,'We observed 2 samples without figures.')
    line(c,330,713,'Methods: each sample was measured once.')
    c.save();print(p.output/'one-page.pdf')
