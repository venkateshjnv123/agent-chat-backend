# gpt_image_2 cost by quality and size

Microcredits per image, from the live tool page. Multiply by `n`.

| Size      | Low    | Medium  | High / Auto |
| --------- | ------ | ------- | ----------- |
| 1024x1024 | 5,880  | 52,680  | 210,720     |
| 1536x1024 | 4,740  | 41,160  | 164,640     |
| 1024x1536 | 4,740  | 41,160  | 164,640     |
| 2048x2048 | 11,910 | 107,040 | 428,160     |
| 2048x1152 | 4,710  | 42,390  | 169,500     |
| 3840x2160 | 11,130 | 100,080 | 400,260     |
| 2160x3840 | 11,130 | 100,080 | 400,260     |

`Auto` is priced as `High`; it is not a cheaper option. A `High` 1024x1024 image
costs roughly 36x a `Low` one, so drafts and intermediate steps in a chain
should be `Low`.
