file(GLOB UTILS_SRC "utils.hpp" "test_utils.cpp" "../src/util.hpp")
add_executable(test_Utils ${UTILS_SRC})
target_link_libraries(test_Utils PRIVATE ${Boost_LIBRARIES})
add_test(NAME test_Utils COMMAND test_Utils)

file(GLOB BITSET_SRC "test_bitset.cpp" "../src/Bitset.hpp" "../src/bitset_util.hpp")
add_executable(test_Bitset ${BITSET_SRC})
target_link_libraries(test_Bitset PRIVATE ${Boost_LIBRARIES})
add_test(NAME test_Bitset COMMAND test_Bitset)

file(GLOB DATASET_SRC "test_dataset.cpp" "../src/Database.*" "../src/Bitset.hpp" "../src/bitset_util.hpp")
add_executable(test_Dataset ${DATASET_SRC})
target_link_libraries(test_Dataset PRIVATE ${Boost_LIBRARIES})
add_test(NAME test_Dataset COMMAND test_Dataset)
