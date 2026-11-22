file(GLOB UTILS_SRC "utils.hpp" "test_utils.cpp" "../src/util.hpp")
add_executable(test_Utils ${UTILS_SRC})
add_test(NAME test_Utils COMMAND test_Utils)

file(GLOB BITSET_SRC "test_bitset.cpp" "../src/Bitset.hpp" "../src/bitset_util.hpp")
add_executable(test_Bitset ${BITSET_SRC})
add_test(NAME test_Bitset COMMAND test_Bitset)

file(GLOB DATASET_SRC "test_dataset.cpp" "../src/Database.*" "../src/Bitset.hpp" "../src/bitset_util.hpp")
add_executable(test_Dataset ${DATASET_SRC})
add_test(NAME test_Dataset COMMAND test_Dataset)

file(GLOB DIFF_MATCH_PATCH_SRC "test_diff_match_patch.cpp" "../src/git_util.cpp" "../src/system_util.cpp")
add_executable(test_diff_match_patch ${DIFF_MATCH_PATCH_SRC})
target_include_directories(test_diff_match_patch PRIVATE ../src)
add_test(NAME test_diff_match_patch COMMAND test_diff_match_patch)
