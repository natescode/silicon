import parse from './parser';
export default function compile(source: string) {

    const match = parse(source);
    // const analyze = analyze(match)
    // return generate(analyze)
}